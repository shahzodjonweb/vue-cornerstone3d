<template>
  <button @click="toSave" class="save">Save Segmentation</button>
  <button @click="restoreSegmentation" class="restore">
    Restore Segmentation
  </button>
  <button @click="toggleCustomSegmentation" class="toggle">
    {{ customSegmentationEnabled ? "Disable" : "Enable" }} Custom Overlay
  </button>
  <button @click="clearCustomSegmentation" class="clear">
    Clear Custom Overlay
  </button>
  <div class="brush-controls" v-if="customSegmentationEnabled">
    <label>Brush Size: {{ brushSize }}</label>
    <input type="range" v-model="brushSize" min="1" max="50" />
    <label>Opacity: {{ brushOpacity }}%</label>
    <input type="range" v-model="brushOpacity" min="10" max="100" />
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
  addTool,
  BrushTool,
  segmentation,
  annotation,
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
let cvReady: any = null;
let savedContours = ref<any[]>([]);

const elementRefAxial = ref<HTMLDivElement | null>(null);
const elementRefSagittal = ref<HTMLDivElement | null>(null);
const elementRefCoronal = ref<HTMLDivElement | null>(null);
const canvasRefAxial = ref<HTMLCanvasElement | null>(null);
const canvasRefSagittal = ref<HTMLCanvasElement | null>(null);
const canvasRefCoronal = ref<HTMLCanvasElement | null>(null);
const running = ref(false);
const customSegmentationEnabled = ref(false);
const brushSize = ref(10);
const brushOpacity = ref(50);
let segmentationId = "MY_SEGMENTATION_ID";
let segmentationData3D: Uint8Array | null = null;
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

  segmentation.addSegmentations([
    {
      segmentationId,
      representation: {
        type: csToolsEnums.SegmentationRepresentations.Labelmap,
        data: { volumeId: segmentationId },
      },
    },
  ]);

  addTool(BrushTool);
  const toolGroupId = "CT_TOOLGROUP";
  toolGroup = ToolGroupManager.createToolGroup(toolGroupId);
  toolGroup.addTool(BrushTool.toolName);
  toolGroup.setToolActive(BrushTool.toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
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

  // Always initialize custom segmentation canvases for overlay display
  setTimeout(() => {
    initializeCustomSegmentation();
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
  let currentSlice = Math.floor(volumeDepth / 2); // Start at middle slice

  // Track current viewport slice changes
  const viewport = renderingEngine?.getViewport(
    orientation === "axial"
      ? viewportIdAxial
      : orientation === "sagittal"
      ? viewportIdSagittal
      : viewportIdCoronal
  );

  const drawBrush = (x: number, y: number) => {
    // Set drawing properties with reactive values
    ctx.globalAlpha = brushOpacity.value / 100;
    ctx.fillStyle = "red";
    const size = brushSize.value;

    // Draw circular brush
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, 2 * Math.PI);
    ctx.fill();

    // Update 3D segmentation data with brush area
    if (segmentationData3D) {
      // Get current slice from viewport if available
      if (viewport && viewport.getCurrentImageIdIndex) {
        currentSlice = viewport.getCurrentImageIdIndex();
      }

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
              let index3D = 0;

              if (orientation === "axial") {
                const scaledX = Math.floor(
                  (brushX * volumeWidth) / canvas.width
                );
                const scaledY = Math.floor(
                  (brushY * volumeHeight) / canvas.height
                );
                index3D =
                  currentSlice * volumeWidth * volumeHeight +
                  scaledY * volumeWidth +
                  scaledX;
              } else if (orientation === "sagittal") {
                const scaledY = Math.floor(
                  (brushY * volumeHeight) / canvas.height
                );
                const scaledZ = Math.floor(
                  (brushX * volumeDepth) / canvas.width
                );
                index3D =
                  scaledZ * volumeWidth * volumeHeight +
                  scaledY * volumeWidth +
                  currentSlice;
              } else if (orientation === "coronal") {
                const scaledX = Math.floor(
                  (brushX * volumeWidth) / canvas.width
                );
                const scaledZ = Math.floor(
                  (brushY * volumeDepth) / canvas.height
                );
                index3D =
                  scaledZ * volumeWidth * volumeHeight +
                  currentSlice * volumeWidth +
                  scaledX;
              }

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

  canvas.addEventListener("mousedown", (e) => {
    if (!customSegmentationEnabled.value) return;
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    lastX = e.clientX - rect.left;
    lastY = e.clientY - rect.top;
    drawBrush(lastX, lastY);
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!isDrawing || !customSegmentationEnabled.value) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    drawLine(lastX, lastY, x, y);
    lastX = x;
    lastY = y;
  });

  canvas.addEventListener("mouseup", () => {
    isDrawing = false;
  });

  canvas.addEventListener("mouseleave", () => {
    isDrawing = false;
  });
};

// Toggle custom segmentation mode
const toggleCustomSegmentation = () => {
  customSegmentationEnabled.value = !customSegmentationEnabled.value;

  if (customSegmentationEnabled.value) {
    initializeCustomSegmentation();
    // Enable pointer events on canvases
    if (canvasRefAxial.value) canvasRefAxial.value.classList.add("active");
    if (canvasRefSagittal.value)
      canvasRefSagittal.value.classList.add("active");
    if (canvasRefCoronal.value) canvasRefCoronal.value.classList.add("active");
    console.log("Custom segmentation enabled");
  } else {
    // Disable pointer events on canvases
    if (canvasRefAxial.value) canvasRefAxial.value.classList.remove("active");
    if (canvasRefSagittal.value)
      canvasRefSagittal.value.classList.remove("active");
    if (canvasRefCoronal.value)
      canvasRefCoronal.value.classList.remove("active");
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
  cvReady = await cv;
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
  pointer-events: none; /* Allow clicks to pass through when not drawing */
  z-index: 10;
}
.segmentation-canvas.active {
  pointer-events: auto; /* Enable mouse events when segmentation is active */
}
.save,
.restore,
.toggle,
.clear {
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
</style>
