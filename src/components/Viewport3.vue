<template>
  <button @click="saveSegmentationPoints" class="save-points">
    💾 Save Points
  </button>
  <button @click="loadSegmentationPoints" class="load-points">
    📂 Load Points
  </button>
  <div class="brush-controls" v-if="customSegmentationEnabled">
    <label>Brush Size: {{ brushSize }}</label>
    <input type="range" v-model="brushSize" min="1" max="50" />
    <label>Opacity: {{ brushOpacity }}%</label>
    <input type="range" v-model="brushOpacity" min="10" max="100" />
  </div>
  <div class="frame-controls">
    <button @click="previousFrame" :disabled="currentFrameIndex <= 0">←</button>
    <span class="frame-info"
      >Frame: {{ currentFrameIndex + 1 }} / {{ totalFrames }}</span
    >
    <button @click="nextFrame" :disabled="currentFrameIndex >= totalFrames - 1">
      →
    </button>
    <input
      type="range"
      v-model="currentFrameIndex"
      min="0"
      :max="totalFrames - 1"
      @input="onFrameChange"
    />
  </div>
  <div class="wrapper">
    <div class="viewport-container">
      <div ref="elementRefAxial" class="viewport" />
      <canvas ref="canvasRefAxial" class="segmentation-canvas" />
    </div>
    <div class="viewport-container">
      <div ref="elementRefSagittal" class="viewport" />
      <canvas ref="canvasRefSagittal" class="segmentation-canvas" />
    </div>
    <div class="viewport-container">
      <div ref="elementRefCoronal" class="viewport" />
      <canvas ref="canvasRefCoronal" class="segmentation-canvas" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import {
  RenderingEngine,
  Enums,
  volumeLoader,
  setVolumesForViewports,
  cache,
  metaData,
  geometryLoader,
} from "@cornerstonejs/core";
import { init as csCoreInit } from "@cornerstonejs/core";
import { init as dicomImageLoaderInit } from "@cornerstonejs/dicom-image-loader";
import {
  init as csToolsInit,
  ToolGroupManager,
  Enums as csToolsEnums,
  segmentation,
  annotation,
  StackScrollTool,
  addTool,
} from "@cornerstonejs/tools";
import { api } from "dicomweb-client";
import wadors from "@cornerstonejs/dicom-image-loader/wadors";
import {
  saveSegmentationToIndexedDB,
  getSegmentationFromIndexedDB,
} from "../segmentationStorage";
import cv from "@techstark/opencv-js";

const STORAGE_KEY = "mySegmentationData";
const CONTOURS_STORAGE_KEY = "savedContours";
const CUSTOM_CONTOURS_KEY = "customCanvasContours";
let cvReady: any = null;
let savedContours = ref<any[]>([]);

const elementRefAxial = ref<HTMLDivElement | null>(null);
const elementRefSagittal = ref<HTMLDivElement | null>(null);
const elementRefCoronal = ref<HTMLDivElement | null>(null);
const canvasRefAxial = ref<HTMLCanvasElement | null>(null);
const canvasRefSagittal = ref<HTMLCanvasElement | null>(null);
const canvasRefCoronal = ref<HTMLCanvasElement | null>(null);
const running = ref(false);
const customSegmentationEnabled = ref(true);
const isDrawingMode = ref(true);
const brushSize = ref(10);
const brushOpacity = ref(50);
const currentFrameIndex = ref(0);
const totalFrames = ref(1);
let segmentationId = "MY_SEGMENTATION_ID";
let segmentationData3D: Uint8Array | null = null;
let frameSegmentations: Map<number, ImageData> = new Map();
const StudyInstanceUID =
  "1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463";
const SeriesInstanceUID =
  "1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561";
const wadoRsRoot = "https://d14fa38qiwhyfd.cloudfront.net/dicomweb";

async function createImageIdsAndCacheMetaData() {
  const dicomClient = new api.DICOMwebClient({
    url: wadoRsRoot,
    singlepart: true,
  });

  const instances = await dicomClient.retrieveSeriesMetadata({
    studyInstanceUID: StudyInstanceUID,
    seriesInstanceUID: SeriesInstanceUID,
  });

  const SOP_INSTANCE_UID = "00080018";
  const SERIES_INSTANCE_UID = "0020000E";

  return instances.map((instance: any) => {
    const sopUID = instance[SOP_INSTANCE_UID]?.Value?.[0];
    const seriesUID = instance[SERIES_INSTANCE_UID]?.Value?.[0];

    const imageId = `wadors:${wadoRsRoot}/studies/${StudyInstanceUID}/series/${seriesUID}/instances/${sopUID}/frames/1`;
    wadors.metaDataManager.add(imageId, instance);
    return imageId;
  });
}

let renderingEngine: RenderingEngine;
let toolGroup: any;
let volumeId: string = `segmentation-volume-${Date.now()}`;
let viewportIdAxial = "CT_AXIAL";
let viewportIdSagittal = "CT_SAGITTAL";
let viewportIdCoronal = "CT_CORONAL";

const setupViewer = async () => {
  if (running.value) return;
  running.value = true;

  if (
    !elementRefAxial.value ||
    !elementRefSagittal.value ||
    !elementRefCoronal.value
  ) {
    console.error("Viewport DOM elements are missing");
    return;
  }

  await csCoreInit();
  await dicomImageLoaderInit();
  await csToolsInit();

  const imageIds = await createImageIdsAndCacheMetaData();

  const renderingEngineId = "myRenderingEngine";
  renderingEngine = new RenderingEngine(renderingEngineId);

  renderingEngine.setViewports([
    {
      viewportId: viewportIdAxial,
      type: Enums.ViewportType.ORTHOGRAPHIC,
      element: elementRefAxial.value,
      defaultOptions: { orientation: Enums.OrientationAxis.AXIAL },
    },
    {
      viewportId: viewportIdSagittal,
      type: Enums.ViewportType.ORTHOGRAPHIC,
      element: elementRefSagittal.value,
      defaultOptions: { orientation: Enums.OrientationAxis.SAGITTAL },
    },
    {
      viewportId: viewportIdCoronal,
      type: Enums.ViewportType.ORTHOGRAPHIC,
      element: elementRefCoronal.value,
      defaultOptions: { orientation: Enums.OrientationAxis.CORONAL },
    },
  ]);

  const volume = await volumeLoader.createAndCacheVolume(volumeId, {
    imageIds,
  });
  volumeLoader.registerUnknownVolumeLoader((volumeId) => {
    const volume = cache.getVolume(volumeId);
    if (!volume) {
      throw new Error(`Volume not found in cache: ${volumeId}`);
    }
    return Promise.resolve(volume);
  });
  await volume.load();

  await volumeLoader.createAndCacheDerivedLabelmapVolume(volumeId, {
    volumeId: segmentationId,
  });

  // Add StackScrollTool for frame navigation
  addTool(StackScrollTool);

  const toolGroupId = "CT_TOOLGROUP";
  toolGroup = ToolGroupManager.createToolGroup(toolGroupId);

  // Add StackScrollTool to the tool group
  toolGroup.addTool(StackScrollTool.toolName);

  // Activate StackScrollTool with mouse wheel and drag
  toolGroup.setToolActive(StackScrollTool.toolName, {
    bindings: [
      {
        mouseButton: csToolsEnums.MouseBindings.Wheel,
      },
      {
        mouseButton: csToolsEnums.MouseBindings.Primary,
        modifierKey: csToolsEnums.KeyboardBindings.Shift,
      },
    ],
  });

  toolGroup.addViewport(viewportIdAxial, renderingEngineId);
  toolGroup.addViewport(viewportIdSagittal, renderingEngineId);
  toolGroup.addViewport(viewportIdCoronal, renderingEngineId);

  await setVolumesForViewports(
    renderingEngine,
    [{ volumeId }],
    [viewportIdAxial, viewportIdSagittal, viewportIdCoronal]
  );

  await segmentation.addLabelmapRepresentationToViewportMap({
    [viewportIdAxial]: [
      {
        segmentationId,
        type: csToolsEnums.SegmentationRepresentations.Labelmap,
      },
    ],
    [viewportIdSagittal]: [
      {
        segmentationId,
        type: csToolsEnums.SegmentationRepresentations.Labelmap,
      },
    ],
    [viewportIdCoronal]: [
      {
        segmentationId,
        type: csToolsEnums.SegmentationRepresentations.Labelmap,
      },
    ],
  });

  renderingEngine.render();

  // Set total frames
  const viewport = renderingEngine.getViewport(viewportIdAxial);
  if (viewport) {
    totalFrames.value = imageIds.length;
    console.log("Total frames:", totalFrames.value);

    // Add event listener for scroll events
    const element = viewport.element as HTMLElement;

    // Function to handle frame change
    const handleFrameChange = () => {
      const newViewport = renderingEngine.getViewport(viewportIdAxial) as any;
      if (newViewport && newViewport.getCurrentImageIdIndex) {
        const newIndex = newViewport.getCurrentImageIdIndex();
        if (newIndex !== currentFrameIndex.value) {
          saveCurrentFrameSegmentation();
          currentFrameIndex.value = newIndex;
          loadFrameSegmentation(newIndex);
        }
      } else if (newViewport) {
        // For volume viewport, calculate slice index from camera position
        const camera = newViewport.getCamera();
        const { focalPoint } = camera;
        const spacing = newViewport.getSpacing
          ? newViewport.getSpacing()
          : [1, 1, 1];
        const origin = newViewport.getOrigin
          ? newViewport.getOrigin()
          : [0, 0, 0];

        // Calculate slice index based on focal point
        const sliceIndex = Math.round((focalPoint[2] - origin[2]) / spacing[2]);
        const clampedIndex = Math.max(
          0,
          Math.min(totalFrames.value - 1, sliceIndex)
        );

        if (clampedIndex !== currentFrameIndex.value) {
          saveCurrentFrameSegmentation();
          currentFrameIndex.value = clampedIndex;
          loadFrameSegmentation(clampedIndex);
        }
      }
    };

    // Listen for wheel events
    element.addEventListener("wheel", (e) => {
      // Small delay to let Cornerstone process the scroll first
      setTimeout(handleFrameChange, 50);
    });

    // Also listen for Cornerstone's own events
    element.addEventListener("cornerstoneimagerendered", handleFrameChange);
    element.addEventListener("cornerstonenewimage", handleFrameChange);
  }

  // Always initialize custom segmentation canvases for overlay display
  setTimeout(() => {
    initializeCustomSegmentation();
    // Load first frame's segmentation if exists
    loadFrameSegmentation(0);
  }, 1000);
};

const restoreSegmentation = async () => {
  const saved = localStorage.getItem("mySegmentation");
  if (!saved) return;

  const parsed = JSON.parse(saved);
  const { width, height, depth, activeSegmentIndex, segmentedVoxels } = parsed;

  const dimensions = [width, height, depth];
  const volumeId = "RESTORED_SEGMENTATION_VOLUME";
  const segmentationId = "RESTORED_SEGMENTATION";

  // 1. Convert qilish
  const scalarData = convertVoxelsToScalarData(
    width,
    height,
    depth,
    segmentedVoxels,
    activeSegmentIndex
  );

  // 2. Volume yaratish
  await volumeLoader.createAndCacheVolume(volumeId, {
    spacing: [1, 1, 1], // yoki original spacing
    origin: [0, 0, 0], // yoki original origin
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], // Identity matrix
    scalarData,
  });

  segmentation.state.addSegmentation({
    segmentationId,
    representation: {
      type: Enums.SegmentationRepresentations.Labelmap,
      data: {
        volumeId,
      },
    },
  });
};

// Initialize custom segmentation canvases
const initializeCustomSegmentation = () => {
  if (
    !canvasRefAxial.value ||
    !canvasRefSagittal.value ||
    !canvasRefCoronal.value
  ) {
    return;
  }

  // Get volume dimensions
  const volume = cache.getVolume(volumeId);
  if (!volume) {
    console.error("Main volume not found");
    return;
  }

  const width = volume.dimensions[0];
  const height = volume.dimensions[1];
  const depth = volume.dimensions[2];

  // Initialize 3D segmentation data array if not exists
  if (!segmentationData3D) {
    segmentationData3D = new Uint8Array(width * height * depth);
  }

  // Set canvas sizes
  canvasRefAxial.value.width = 512;
  canvasRefAxial.value.height = 512;
  canvasRefSagittal.value.width = 512;
  canvasRefSagittal.value.height = 512;
  canvasRefCoronal.value.width = 512;
  canvasRefCoronal.value.height = 512;

  // Setup drawing on canvases
  setupCanvasDrawing(canvasRefAxial.value, "axial", width, height, depth);
  setupCanvasDrawing(canvasRefSagittal.value, "sagittal", width, height, depth);
  setupCanvasDrawing(canvasRefCoronal.value, "coronal", width, height, depth);
};

// Frame navigation functions
const previousFrame = () => {
  if (currentFrameIndex.value > 0) {
    saveCurrentFrameSegmentation();
    currentFrameIndex.value--;
    changeFrame(currentFrameIndex.value);
  }
};

const nextFrame = () => {
  if (currentFrameIndex.value < totalFrames.value - 1) {
    saveCurrentFrameSegmentation();
    currentFrameIndex.value++;
    changeFrame(currentFrameIndex.value);
  }
};

const onFrameChange = () => {
  saveCurrentFrameSegmentation();
  changeFrame(currentFrameIndex.value);
};

const changeFrame = (frameIndex: number) => {
  if (!renderingEngine) return;

  // Update axial viewport to show the new frame using scroll
  const viewport = renderingEngine.getViewport(viewportIdAxial) as any;
  if (viewport) {
    // For volume viewports, we need to scroll through the slices
    if (viewport.setSlabThickness) {
      // This is a volume viewport
      const camera = viewport.getCamera();
      const { viewPlaneNormal, focalPoint } = camera;

      // Calculate the distance to scroll
      const spacing = viewport.getSpacing ? viewport.getSpacing() : [1, 1, 1];
      const delta = (frameIndex - currentFrameIndex.value) * spacing[2];

      // Update focal point to scroll to the new slice
      const newFocalPoint = [
        focalPoint[0] + viewPlaneNormal[0] * delta,
        focalPoint[1] + viewPlaneNormal[1] * delta,
        focalPoint[2] + viewPlaneNormal[2] * delta,
      ];

      viewport.setCamera({
        ...camera,
        focalPoint: newFocalPoint,
      });
    } else if (viewport.setImageIdIndex) {
      // This is a stack viewport
      viewport.setImageIdIndex(frameIndex);
    }

    renderingEngine.render();
  }

  // Load segmentation for this frame
  loadFrameSegmentation(frameIndex);
};

// Save current frame segmentation before switching
const saveCurrentFrameSegmentation = () => {
  if (!canvasRefAxial.value) return;

  const ctx = canvasRefAxial.value.getContext("2d");
  if (ctx) {
    const imageData = ctx.getImageData(
      0,
      0,
      canvasRefAxial.value.width,
      canvasRefAxial.value.height
    );

    // Check if there's actual data to save
    let hasData = false;
    for (let i = 0; i < imageData.data.length; i += 4) {
      if (imageData.data[i] > 0) {
        // Check red channel
        hasData = true;
        break;
      }
    }

    if (hasData) {
      frameSegmentations.set(currentFrameIndex.value, imageData);
      console.log(
        `Saved segmentation for frame ${currentFrameIndex.value + 1}`
      );
    } else if (frameSegmentations.has(currentFrameIndex.value)) {
      // If canvas is empty but we had data before, keep it
      console.log(
        `Frame ${
          currentFrameIndex.value + 1
        } canvas empty, keeping previous data`
      );
    }
  }
};

// Load segmentation for specific frame
const loadFrameSegmentation = (frameIndex: number) => {
  // Load for all canvases
  if (canvasRefAxial.value) {
    const ctx = canvasRefAxial.value.getContext("2d");
    if (ctx) {
      // Clear canvas first
      ctx.clearRect(
        0,
        0,
        canvasRefAxial.value.width,
        canvasRefAxial.value.height
      );

      // Load saved segmentation for this frame if exists
      const savedSegmentation = frameSegmentations.get(frameIndex);
      if (savedSegmentation) {
        ctx.putImageData(savedSegmentation, 0, 0);
        console.log(`Loaded segmentation for frame ${frameIndex + 1}`);
      } else {
        console.log(`No segmentation for frame ${frameIndex + 1}`);
      }
    }
  }

  // Clear other views since they show different orientations
  if (canvasRefSagittal.value) {
    const ctx = canvasRefSagittal.value.getContext("2d");
    if (ctx) {
      ctx.clearRect(
        0,
        0,
        canvasRefSagittal.value.width,
        canvasRefSagittal.value.height
      );
    }
  }

  if (canvasRefCoronal.value) {
    const ctx = canvasRefCoronal.value.getContext("2d");
    if (ctx) {
      ctx.clearRect(
        0,
        0,
        canvasRefCoronal.value.width,
        canvasRefCoronal.value.height
      );
    }
  }
};

// Clear current frame segmentation
const clearCurrentFrame = () => {
  if (!canvasRefAxial.value) return;

  const ctx = canvasRefAxial.value.getContext("2d");
  if (ctx) {
    ctx.clearRect(
      0,
      0,
      canvasRefAxial.value.width,
      canvasRefAxial.value.height
    );
    frameSegmentations.delete(currentFrameIndex.value);
  }

  console.log(`Cleared frame ${currentFrameIndex.value + 1}`);
};

// Extract segmentation data in an optimized format
const extractSegmentationData = (imageData: ImageData) => {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;

  // Create a more compact representation using run-length encoding
  const runs: { y: number; x1: number; x2: number }[] = [];

  for (let y = 0; y < height; y++) {
    let inRun = false;
    let runStart = 0;

    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const isFilled = data[idx] > 0;

      if (isFilled && !inRun) {
        // Start of a new run
        inRun = true;
        runStart = x;
      } else if (!isFilled && inRun) {
        // End of a run
        runs.push({ y, x1: runStart, x2: x - 1 });
        inRun = false;
      }
    }

    // Handle run that extends to the end of the row
    if (inRun) {
      runs.push({ y, x1: runStart, x2: width - 1 });
    }
  }

  return runs;
};

// Save segmentation points to localStorage
const saveSegmentationPoints = () => {
  // Save current frame first
  saveCurrentFrameSegmentation();

  const segmentationData = {
    version: "1.0",
    timestamp: new Date().toISOString(),
    studyUID: StudyInstanceUID,
    seriesUID: SeriesInstanceUID,
    totalFrames: totalFrames.value,
    canvasWidth: 512,
    canvasHeight: 512,
    frames: [] as any[],
  };

  // Process each frame
  frameSegmentations.forEach((imageData, frameIndex) => {
    // Extract segmentation runs (more efficient than individual points)
    const runs = extractSegmentationData(imageData);

    // Also save as base64 for complete data
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = imageData.width;
    tempCanvas.height = imageData.height;
    const ctx = tempCanvas.getContext("2d");
    if (ctx) {
      ctx.putImageData(imageData, 0, 0);
      const base64 = tempCanvas.toDataURL("image/png");

      segmentationData.frames.push({
        frameIndex,
        runCount: runs.length,
        runs: runs, // Array of {y, x1, x2} objects (horizontal runs)
        base64: base64, // Complete image data
      });
    }
  });

  // Save to localStorage
  const key = `segmentation_${StudyInstanceUID}_${SeriesInstanceUID}`;
  localStorage.setItem(key, JSON.stringify(segmentationData));

  console.log(`Saved segmentation data:`);
  console.log(`- ${segmentationData.frames.length} frames`);
  console.log(
    `- Total runs: ${segmentationData.frames.reduce(
      (sum, f) => sum + (f.runCount || 0),
      0
    )}`
  );

  alert(
    `Segmentation saved! ${segmentationData.frames.length} frames saved to localStorage.`
  );
};

// Load segmentation points from localStorage
const loadSegmentationPoints = () => {
  const key = `segmentation_${StudyInstanceUID}_${SeriesInstanceUID}`;
  const savedData = localStorage.getItem(key);

  if (!savedData) {
    alert("No saved segmentation found for this series.");
    return;
  }

  const segmentationData = JSON.parse(savedData);
  console.log(`Loading segmentation data from ${segmentationData.timestamp}`);

  // Clear existing segmentations
  frameSegmentations.clear();
  clearCustomSegmentation();

  // Restore each frame
  segmentationData.frames.forEach((frameData: any) => {
    const { frameIndex, points, base64 } = frameData;

    // Always prefer base64 if available (it has the full filled area)
    if (base64) {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = segmentationData.canvasWidth;
        canvas.height = segmentationData.canvasHeight;
        const ctx = canvas.getContext("2d");

        if (ctx) {
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          frameSegmentations.set(frameIndex, imageData);

          // If this is the current frame, display it
          if (frameIndex === currentFrameIndex.value) {
            loadFrameSegmentation(frameIndex);
          }
        }
      };
      img.src = base64;
    }
    // Fallback: Reconstruct from runs if base64 is not available
    else if (frameData.runs && frameData.runs.length > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = segmentationData.canvasWidth;
      canvas.height = segmentationData.canvasHeight;
      const ctx = canvas.getContext("2d");

      if (ctx) {
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Set fill properties
        ctx.fillStyle = "red";
        ctx.globalAlpha = brushOpacity.value / 100;

        // Draw all runs to fill the complete area
        frameData.runs.forEach((run: { y: number; x1: number; x2: number }) => {
          // Draw a horizontal line from x1 to x2 at y
          ctx.fillRect(run.x1, run.y, run.x2 - run.x1 + 1, 1);
        });

        // Get the ImageData
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        frameSegmentations.set(frameIndex, imageData);
      }
    }
  });

  // Load current frame
  setTimeout(() => {
    loadFrameSegmentation(currentFrameIndex.value);
  }, 100);

  alert(
    `Segmentation loaded! ${segmentationData.frames.length} frames restored.`
  );
};

// Setup drawing functionality for each canvas
const setupCanvasDrawing = (
  canvas: HTMLCanvasElement,
  orientation: "axial" | "sagittal" | "coronal",
  volumeWidth: number,
  volumeHeight: number,
  volumeDepth: number
) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let isDrawing = false;

  // Always allow pointer events to pass through
  canvas.style.pointerEvents = "none";

  const drawBrush = (x: number, y: number) => {
    // Set drawing properties with reactive values
    ctx.globalAlpha = brushOpacity.value / 100;
    ctx.fillStyle = "red";
    const size = brushSize.value;

    // Draw circular brush
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, 2 * Math.PI);
    ctx.fill();

    // For axial view, also update the 3D data if needed
    if (orientation === "axial" && segmentationData3D) {
      const currentSlice = currentFrameIndex.value;

      // Fill brush area in 3D data
      for (let dx = -Math.floor(size / 2); dx <= Math.floor(size / 2); dx++) {
        for (let dy = -Math.floor(size / 2); dy <= Math.floor(size / 2); dy++) {
          // Check if within circle
          if (dx * dx + dy * dy <= (size / 2) * (size / 2)) {
            const brushX = x + dx;
            const brushY = y + dy;

            if (
              brushX >= 0 &&
              brushX < canvas.width &&
              brushY >= 0 &&
              brushY < canvas.height
            ) {
              const scaledX = Math.floor((brushX * volumeWidth) / canvas.width);
              const scaledY = Math.floor(
                (brushY * volumeHeight) / canvas.height
              );
              const index3D =
                currentSlice * volumeWidth * volumeHeight +
                scaledY * volumeWidth +
                scaledX;

              if (index3D >= 0 && index3D < segmentationData3D.length) {
                segmentationData3D[index3D] = 1;
              }
            }
          }
        }
      }
    }
  };

  // Draw function for continuous stroke
  let lastX = 0;
  let lastY = 0;

  const drawLine = (x1: number, y1: number, x2: number, y2: number) => {
    const distance = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
    const steps = Math.max(Math.floor(distance / 2), 1);

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      drawBrush(x, y);
    }
  };

  // Get the viewport element that contains this canvas
  const viewportElement = canvas.previousElementSibling as HTMLElement;
  if (!viewportElement) return;

  // Add event listeners to the viewport element instead of canvas
  viewportElement.addEventListener("mousedown", (e) => {
    if (!customSegmentationEnabled.value) return;

    // Only draw when in drawing mode
    if (!isDrawingMode.value) {
      return; // Let normal viewport interactions work
    }

    // Prevent default to stop viewport from processing this event
    e.preventDefault();
    e.stopPropagation();

    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    lastX = e.clientX - rect.left;
    lastY = e.clientY - rect.top;
    drawBrush(lastX, lastY);
  });

  viewportElement.addEventListener("mousemove", (e) => {
    if (!isDrawing || !customSegmentationEnabled.value) return;

    // Continue drawing only in drawing mode
    if (!isDrawingMode.value) {
      isDrawing = false;
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    drawLine(lastX, lastY, x, y);
    lastX = x;
    lastY = y;
  });

  viewportElement.addEventListener("mouseup", () => {
    isDrawing = false;
  });

  viewportElement.addEventListener("mouseleave", () => {
    isDrawing = false;
  });
};

// Toggle drawing mode
const toggleDrawingMode = () => {
  isDrawingMode.value = !isDrawingMode.value;
  console.log(
    isDrawingMode.value ? "Drawing mode enabled" : "Navigation mode enabled"
  );
};

// Toggle custom segmentation mode
const toggleCustomSegmentation = () => {
  // customSegmentationEnabled.value = !customSegmentationEnabled.value;

  if (customSegmentationEnabled.value) {
    initializeCustomSegmentation();
    isDrawingMode.value = true; // Start in navigation mode
    console.log(
      "Custom segmentation enabled - Use the Drawing Mode button to switch between drawing and navigation"
    );
    alert(
      "Click 'Drawing Mode' button to switch between drawing and navigation. In Navigation mode, scroll and drag work normally. In Drawing mode, you can draw segmentation."
    );
  } else {
    // isDrawingMode.value = false;
    console.log("Custom segmentation disabled");
  }
};

// Clear custom segmentation
const clearCustomSegmentation = () => {
  // Clear canvases
  if (canvasRefAxial.value) {
    const ctx = canvasRefAxial.value.getContext("2d");
    if (ctx)
      ctx.clearRect(
        0,
        0,
        canvasRefAxial.value.width,
        canvasRefAxial.value.height
      );
  }
  if (canvasRefSagittal.value) {
    const ctx = canvasRefSagittal.value.getContext("2d");
    if (ctx)
      ctx.clearRect(
        0,
        0,
        canvasRefSagittal.value.width,
        canvasRefSagittal.value.height
      );
  }
  if (canvasRefCoronal.value) {
    const ctx = canvasRefCoronal.value.getContext("2d");
    if (ctx)
      ctx.clearRect(
        0,
        0,
        canvasRefCoronal.value.width,
        canvasRefCoronal.value.height
      );
  }

  // Clear 3D data
  if (segmentationData3D) {
    segmentationData3D.fill(0);
  }

  console.log("Custom segmentation cleared");
};

// Save custom segmentation contours using OpenCV - save all frames
const saveCustomContours = async () => {
  // Save current frame first
  saveCurrentFrameSegmentation();

  const allFramesData = {
    frames: [] as any[],
    totalFrames: totalFrames.value,
    canvasWidth: 512,
    canvasHeight: 512,
    timestamp: Date.now(),
  };

  // Save each frame's segmentation
  frameSegmentations.forEach((imageData, frameIndex) => {
    // Convert ImageData to base64
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = imageData.width;
    tempCanvas.height = imageData.height;
    const ctx = tempCanvas.getContext("2d");
    if (ctx) {
      ctx.putImageData(imageData, 0, 0);
      const base64 = tempCanvas.toDataURL("image/png");
      allFramesData.frames.push({
        frameIndex,
        base64,
      });
    }
  });

  // Save to localStorage
  localStorage.setItem(CUSTOM_CONTOURS_KEY, JSON.stringify(allFramesData));
  console.log(`Saved ${allFramesData.frames.length} frames to localStorage`);

  // Also save with OpenCV if available
  if (!cvReady) {
    console.log("OpenCV not ready, saved as base64 only");
    return;
  }

  const contoursData = {
    axial: null as any,
    sagittal: null as any,
    coronal: null as any,
    canvasWidth: 512,
    canvasHeight: 512,
    allFrames: allFramesData,
    timestamp: Date.now(),
  };

  // Process axial canvas
  if (canvasRefAxial.value) {
    const ctx = canvasRefAxial.value.getContext("2d");
    if (ctx) {
      const imageData = ctx.getImageData(
        0,
        0,
        canvasRefAxial.value.width,
        canvasRefAxial.value.height
      );
      const contours = extractContoursFromCanvas(imageData, "axial");
      if (contours) {
        contoursData.axial = contours;
      }
    }
  }

  // Process sagittal canvas
  if (canvasRefSagittal.value) {
    const ctx = canvasRefSagittal.value.getContext("2d");
    if (ctx) {
      const imageData = ctx.getImageData(
        0,
        0,
        canvasRefSagittal.value.width,
        canvasRefSagittal.value.height
      );
      const contours = extractContoursFromCanvas(imageData, "sagittal");
      if (contours) {
        contoursData.sagittal = contours;
      }
    }
  }

  // Process coronal canvas
  if (canvasRefCoronal.value) {
    const ctx = canvasRefCoronal.value.getContext("2d");
    if (ctx) {
      const imageData = ctx.getImageData(
        0,
        0,
        canvasRefCoronal.value.width,
        canvasRefCoronal.value.height
      );
      const contours = extractContoursFromCanvas(imageData, "coronal");
      if (contours) {
        contoursData.coronal = contours;
      }
    }
  }

  // Save to localStorage
  localStorage.setItem(CUSTOM_CONTOURS_KEY, JSON.stringify(contoursData));
  console.log("Custom canvas contours saved:", contoursData);

  // Also save as base64 for backup
  if (canvasRefAxial.value) {
    const base64 = canvasRefAxial.value.toDataURL("image/png");
    localStorage.setItem(CUSTOM_CONTOURS_KEY + "_axial_base64", base64);
  }
};

// Extract contours from canvas image data using OpenCV
const extractContoursFromCanvas = (
  imageData: ImageData,
  orientation: string
) => {
  if (!cvReady) return null;

  try {
    const width = imageData.width;
    const height = imageData.height;
    const pixels = imageData.data;

    // Create grayscale image from RGBA data
    const grayData = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const pixelIndex = i * 4;
      // Get red channel (since we draw in red)
      grayData[i] = pixels[pixelIndex] > 0 ? 255 : 0;
    }

    // Create OpenCV Mat from grayscale data
    const mat = new cvReady.Mat(height, width, cvReady.CV_8UC1);
    mat.data.set(grayData);

    // Find contours
    const contours = new cvReady.MatVector();
    const hierarchy = new cvReady.Mat();

    cvReady.findContours(
      mat,
      contours,
      hierarchy,
      cvReady.RETR_EXTERNAL,
      cvReady.CHAIN_APPROX_SIMPLE
    );

    // Convert contours to points array
    const contourPoints = [];
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const points = [];
      for (let j = 0; j < contour.rows; j++) {
        points.push({
          x: contour.data32S[j * 2],
          y: contour.data32S[j * 2 + 1],
        });
      }
      if (points.length > 0) {
        contourPoints.push(points);
      }
      contour.delete();
    }

    // Clean up
    mat.delete();
    contours.delete();
    hierarchy.delete();

    console.log(
      `Found ${contourPoints.length} contours in ${orientation} canvas`
    );

    return {
      orientation,
      contours: contourPoints,
      width,
      height,
    };
  } catch (error) {
    console.error("Error extracting contours:", error);

    // Fallback: just save raw canvas data as base64
    return {
      orientation,
      contours: [],
      width: imageData.width,
      height: imageData.height,
      fallbackData: true,
    };
  }
};

// Restore custom contours from localStorage - restore all frames
const restoreCustomContours = async () => {
  const savedData = localStorage.getItem(CUSTOM_CONTOURS_KEY);
  if (!savedData) {
    console.log("No saved contours found");
    return;
  }

  const data = JSON.parse(savedData);

  // Check if it's multi-frame data
  if (data.frames && Array.isArray(data.frames)) {
    // Clear existing frame segmentations
    frameSegmentations.clear();

    // Restore each frame
    for (const frameData of data.frames) {
      const { frameIndex, base64 } = frameData;

      const img = new Image();
      img.onload = () => {
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = data.canvasWidth;
        tempCanvas.height = data.canvasHeight;
        const ctx = tempCanvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(
            0,
            0,
            tempCanvas.width,
            tempCanvas.height
          );
          frameSegmentations.set(frameIndex, imageData);

          // If this is the current frame, display it
          if (frameIndex === currentFrameIndex.value) {
            loadFrameSegmentation(frameIndex);
          }
        }
      };
      img.src = base64;
    }

    console.log(`Restored ${data.frames.length} frames from localStorage`);
    return;
  }

  // Fallback to old single-frame format
  const contoursData = data;

  // Clear existing canvases
  clearCustomSegmentation();

  // Restore axial canvas
  if (contoursData.axial && canvasRefAxial.value) {
    restoreContoursToCanvas(canvasRefAxial.value, contoursData.axial);
  }

  // Restore sagittal canvas
  if (contoursData.sagittal && canvasRefSagittal.value) {
    restoreContoursToCanvas(canvasRefSagittal.value, contoursData.sagittal);
  }

  // Restore coronal canvas
  if (contoursData.coronal && canvasRefCoronal.value) {
    restoreContoursToCanvas(canvasRefCoronal.value, contoursData.coronal);
  }

  // Alternative: restore from base64 if available
  const base64Axial = localStorage.getItem(
    CUSTOM_CONTOURS_KEY + "_axial_base64"
  );
  if (base64Axial && canvasRefAxial.value) {
    const img = new Image();
    img.onload = () => {
      const ctx = canvasRefAxial.value!.getContext("2d");
      if (ctx) {
        ctx.clearRect(
          0,
          0,
          canvasRefAxial.value!.width,
          canvasRefAxial.value!.height
        );
        ctx.drawImage(img, 0, 0);
      }
    };
    img.src = base64Axial;
  }

  console.log("Custom contours restored");
};

// Helper function to restore contours to a specific canvas
const restoreContoursToCanvas = (
  canvas: HTMLCanvasElement,
  contourData: any
) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Clear canvas first
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Set drawing properties
  ctx.globalAlpha = brushOpacity.value / 100;
  ctx.fillStyle = "red";
  ctx.strokeStyle = "red";
  ctx.lineWidth = 2;

  // Draw all contours
  for (const contourPoints of contourData.contours) {
    if (contourPoints.length > 0) {
      ctx.beginPath();
      ctx.moveTo(contourPoints[0].x, contourPoints[0].y);

      for (let i = 1; i < contourPoints.length; i++) {
        ctx.lineTo(contourPoints[i].x, contourPoints[i].y);
      }

      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  console.log(
    `Restored ${contourData.contours.length} contours to ${contourData.orientation} canvas`
  );
};

// Redraw custom segmentation on canvases
const redrawCustomSegmentation = () => {
  if (!segmentationData3D) return;

  const volume = cache.getVolume(volumeId);
  if (!volume) return;

  const width = volume.dimensions[0];
  const height = volume.dimensions[1];
  const depth = volume.dimensions[2];

  // Redraw axial canvas (z-slice)
  if (canvasRefAxial.value) {
    const ctx = canvasRefAxial.value.getContext("2d");
    if (ctx) {
      ctx.clearRect(
        0,
        0,
        canvasRefAxial.value.width,
        canvasRefAxial.value.height
      );
      ctx.globalAlpha = brushOpacity.value / 100;
      ctx.fillStyle = "red";

      const z = Math.floor(depth / 2); // Middle slice for now
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const index3D = z * width * height + y * width + x;
          if (segmentationData3D[index3D] > 0) {
            const canvasX = (x * canvasRefAxial.value.width) / width;
            const canvasY = (y * canvasRefAxial.value.height) / height;
            ctx.fillRect(canvasX, canvasY, 2, 2);
          }
        }
      }
    }
  }

  // Similar for sagittal and coronal views
  // ... (can add if needed)
};

const toSave = async () => {
  if (!cvReady) {
    return;
  }

  let segmentationScalarData;
  let width, height, depth;

  // Check if we should use custom segmentation or Cornerstone segmentation
  if (customSegmentationEnabled.value && segmentationData3D) {
    console.log("Using custom segmentation data");

    // Get volume dimensions from main volume
    const volume = cache.getVolume(volumeId);
    if (!volume) {
      console.error("Main volume not found");
      return;
    }

    width = volume.dimensions[0];
    height = volume.dimensions[1];
    depth = volume.dimensions[2];
    segmentationScalarData = segmentationData3D;
  } else {
    console.log("Attempting to use Cornerstone segmentation data");

    // Get the segmentation volume (labelmap)
    const segmentationVolume = cache.getVolume(segmentationId);
    if (!segmentationVolume) {
      console.error("Segmentation volume not found");
      return;
    }

    console.log("Segmentation volume:", segmentationVolume);
    console.log("Volume properties:", Object.keys(segmentationVolume));

    // Get dimensions
    width = segmentationVolume.dimensions[0];
    height = segmentationVolume.dimensions[1];
    depth = segmentationVolume.dimensions[2];

    // Try different ways to access the scalar data
    // Method 1: Direct scalarData property
    if (segmentationVolume.scalarData) {
      segmentationScalarData = segmentationVolume.scalarData;
      console.log("Got scalar data from .scalarData property");
    }
    // Method 2: voxelManager (if it exists)
    else if (
      segmentationVolume.voxelManager &&
      segmentationVolume.voxelManager.getScalarData
    ) {
      segmentationScalarData = segmentationVolume.voxelManager.getScalarData();
      console.log("Got scalar data from voxelManager.getScalarData()");
    }
    // Method 3: getScalarData method
    else if (typeof segmentationVolume.getScalarData === "function") {
      segmentationScalarData = segmentationVolume.getScalarData();
      console.log("Got scalar data from .getScalarData() method");
    }
    // Method 4: imageData property (for some volume types)
    else if (
      segmentationVolume.imageData &&
      segmentationVolume.imageData.getScalarData
    ) {
      segmentationScalarData = segmentationVolume.imageData.getScalarData();
      console.log("Got scalar data from .imageData.getScalarData()");
    }

    if (!segmentationScalarData) {
      console.error("Could not access scalar data from segmentation volume");
      console.log("Available methods/properties:", segmentationVolume);
      return;
    }
  }

  // Get annotations
  const annotations = annotation.state.getAllAnnotations();
  console.log("Annotations:", annotations);

  // Check if there's any actual segmentation data
  let hasSegmentationData = false;
  for (let i = 0; i < Math.min(1000, segmentationScalarData.length); i++) {
    if (segmentationScalarData[i] !== 0) {
      hasSegmentationData = true;
      break;
    }
  }

  console.log("Has segmentation data:", hasSegmentationData);
  console.log(
    "First 100 values:",
    Array.from(segmentationScalarData.slice(0, 100))
  );

  // Convert typed array to base64
  // For large arrays, we need to chunk the conversion to avoid call stack issues
  let base64String = "";

  try {
    if (segmentationScalarData instanceof Uint8Array) {
      // For Uint8Array, chunk the conversion
      const chunkSize = 8192;
      const chunks = [];
      for (let i = 0; i < segmentationScalarData.length; i += chunkSize) {
        const chunk = segmentationScalarData.slice(i, i + chunkSize);
        const binaryString = Array.from(chunk)
          .map((byte) => String.fromCharCode(byte))
          .join("");
        chunks.push(binaryString);
      }
      base64String = btoa(chunks.join(""));
    } else if (segmentationScalarData instanceof Uint16Array) {
      // For Uint16Array, we need to convert to bytes first
      const uint8Array = new Uint8Array(segmentationScalarData.buffer);
      const chunkSize = 8192;
      const chunks = [];
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.slice(i, i + chunkSize);
        const binaryString = Array.from(chunk)
          .map((byte) => String.fromCharCode(byte))
          .join("");
        chunks.push(binaryString);
      }
      base64String = btoa(chunks.join(""));
    } else if (segmentationScalarData instanceof Float32Array) {
      // For Float32Array, convert to bytes
      const uint8Array = new Uint8Array(segmentationScalarData.buffer);
      const chunkSize = 8192;
      const chunks = [];
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.slice(i, i + chunkSize);
        const binaryString = Array.from(chunk)
          .map((byte) => String.fromCharCode(byte))
          .join("");
        chunks.push(binaryString);
      }
      base64String = btoa(chunks.join(""));
    }
  } catch (error) {
    console.error("Error converting to base64:", error);
  }

  // Log the base64 segmentation data
  console.log("=== PIXEL-PERFECT SEGMENTATION DATA ===");
  console.log("Dimensions:", { width, height, depth });
  console.log("Total voxels:", width * height * depth);
  console.log("Data type:", segmentationScalarData.constructor.name);
  console.log("Data length:", segmentationScalarData.length);
  console.log("Base64 length:", base64String.length);

  // Log first part of base64 to verify it's not all zeros
  console.log(
    "Base64 preview (first 100 chars):",
    base64String.substring(0, 100)
  );
  console.log("Base64 segmentation data:", base64String);

  // Also create a more compact representation for specific segments
  const activeSegmentIndex = 1;
  const segmentedVoxels = [];

  // Count non-zero voxels and create sparse representation
  let nonZeroCount = 0;
  for (let i = 0; i < segmentationScalarData.length; i++) {
    if (segmentationScalarData[i] !== 0) {
      nonZeroCount++;
      if (segmentationScalarData[i] === activeSegmentIndex) {
        // Calculate x, y, z from linear index
        const z = Math.floor(i / (width * height));
        const remainder = i % (width * height);
        const y = Math.floor(remainder / width);
        const x = remainder % width;
        segmentedVoxels.push({ x, y, z });
      }
    }
  }

  console.log("Non-zero voxels:", nonZeroCount);
  console.log("Active segment voxels:", segmentedVoxels.length);

  // Save both representations
  const dataToSave = {
    width,
    height,
    depth,
    activeSegmentIndex,
    segmentedVoxels,
    base64Data: base64String,
    dataType: segmentationScalarData.constructor.name,
  };

  localStorage.setItem("mySegmentation", JSON.stringify(dataToSave));
  console.log("Segmentation saved to localStorage with base64 data");

  // Also try to get segmentation state from the segmentation module
  const segmentationState = segmentation.state.getSegmentation(segmentationId);
  console.log("Segmentation state:", segmentationState);

  // Get segmentation representations
  const segmentationReps =
    segmentation.state.getSegmentationRepresentations(segmentationId);
  console.log("Segmentation representations:", segmentationReps);
};

function convertVoxelsToScalarData(
  width: number,
  height: number,
  depth: number,
  segmentedVoxels: { x: number; y: number; z: number }[],
  segmentIndex: number
): Uint8Array {
  const scalarData = new Uint8Array(width * height * depth);

  for (const { x, y, z } of segmentedVoxels) {
    const index = z * width * height + y * width + x;
    scalarData[index] = segmentIndex;
  }

  return scalarData;
}

onMounted(async () => {
  await setupViewer();

  // Initialize OpenCV
  try {
    cvReady = await cv;
    console.log("OpenCV loaded successfully");
  } catch (error) {
    console.error("Failed to load OpenCV:", error);
    // Even if OpenCV fails, the app should continue working
    cvReady = null;
  }

  // Add keyboard shortcut for toggling drawing mode
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && customSegmentationEnabled.value) {
      e.preventDefault();
      toggleDrawingMode();
    }
  });
});

onUnmounted(() => {
  if (renderingEngine) {
    renderingEngine.destroy();
  }
  if (toolGroup) {
    ToolGroupManager.destroyToolGroup(toolGroup.id);
  }
  cache.purgeCache();
  running.value = false;
});
</script>

<style scoped>
.wrapper {
  display: flex;
  gap: 8px;
}
.viewport-container {
  position: relative;
  width: 512px;
  height: 512px;
}
.viewport {
  width: 512px;
  height: 512px;
  background-color: black;
}
.segmentation-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 512px;
  height: 512px;
  pointer-events: none; /* Default: allow all events to pass through */
  z-index: 10;
}
/* Remove the active class CSS - we'll handle this in JavaScript */
.save,
.restore,
.toggle,
.clear,
.save-contours,
.restore-contours {
  margin: 5px;
  padding: 10px;
  cursor: pointer;
}
.toggle {
  background-color: #4caf50;
  color: white;
  border: none;
  border-radius: 4px;
}
.toggle:hover {
  background-color: #45a049;
}
.clear {
  background-color: #f44336;
  color: white;
  border: none;
  border-radius: 4px;
}
.clear:hover {
  background-color: #da190b;
}
.save-contours {
  background-color: #2196f3;
  color: white;
  border: none;
  border-radius: 4px;
}
.save-contours:hover {
  background-color: #0b7dda;
}
.restore-contours {
  background-color: #9c27b0;
  color: white;
  border: none;
  border-radius: 4px;
}
.restore-contours:hover {
  background-color: #7b1fa2;
}
.brush-controls {
  display: inline-flex;
  align-items: center;
  gap: 15px;
  margin: 5px;
  padding: 10px;
  background-color: #f5f5f5;
  border-radius: 4px;
}
.brush-controls label {
  font-size: 14px;
  color: #333;
  min-width: 100px;
}
.brush-controls input[type="range"] {
  width: 150px;
}
.drawing-mode-btn {
  background-color: #2196f3;
  color: white;
  padding: 8px 15px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
  font-size: 14px;
  transition: all 0.3s;
}
.drawing-mode-btn:hover {
  background-color: #1976d2;
}
.drawing-mode-btn.active {
  background-color: #ff5722;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(255, 87, 34, 0.7);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(255, 87, 34, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(255, 87, 34, 0);
  }
}
.frame-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 5px;
  padding: 10px;
  background-color: #2c3e50;
  border-radius: 4px;
}
.frame-controls button {
  padding: 5px 10px;
  background-color: #3498db;
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 18px;
}
.frame-controls button:hover:not(:disabled) {
  background-color: #2980b9;
}
.frame-controls button:disabled {
  background-color: #7f8c8d;
  cursor: not-allowed;
}
.frame-info {
  color: white;
  font-weight: bold;
  min-width: 120px;
  text-align: center;
}
.frame-controls input[type="range"] {
  flex: 1;
  max-width: 300px;
}
.clear-frame {
  background-color: #e67e22;
  color: white;
  border: none;
  border-radius: 4px;
}
.clear-frame:hover {
  background-color: #d35400;
}
.save-points {
  background-color: #4caf50;
  color: white;
  border: none;
  border-radius: 4px;
  margin: 5px;
  padding: 10px;
  cursor: pointer;
}
.save-points:hover {
  background-color: #45a049;
}
.load-points {
  background-color: #2196f3;
  color: white;
  border: none;
  border-radius: 4px;
  margin: 5px;
  padding: 10px;
  cursor: pointer;
}
.load-points:hover {
  background-color: #1976d2;
}
</style>
