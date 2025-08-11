<template>
  <div class="controls-container">
    <button @click="toSave" class="save">Save Segmentation</button>
    <button @click="toSave2" class="save-contours">Extract Contours</button>
    <button @click="restoreSegmentation" class="restore">
      Restore Segmentation
    </button>
    
    <!-- Drawing Tools -->
    <div class="drawing-tools">
      <label>Drawing Tools:</label>
      <div class="tool-buttons">
        <button 
          @click="setActiveTool('Brush')" 
          :class="['tool-btn', { active: activeTool === 'Brush' }]"
        >
          🖌️ Brush
        </button>
        <button 
          @click="setActiveTool('Rectangle')" 
          :class="['tool-btn', { active: activeTool === 'Rectangle' }]"
        >
          📦 BBOX
        </button>
        <button 
          @click="setActiveTool('Polygon')" 
          :class="['tool-btn', { active: activeTool === 'Polygon' }]"
        >
          🔗 Polygon
        </button>
      </div>
    </div>

    <!-- Annotation Controls -->
    <div class="annotation-controls">
      <button @click="clearAnnotations" class="clear-btn">
        🗑️ Clear Annotations
      </button>
      <button @click="saveAnnotations" class="save-annotations">
        💾 Save Annotations
      </button>
      <button @click="loadAnnotations" class="load-annotations">
        📂 Load Annotations
      </button>
    </div>

    <div class="segment-controls">
      <label>Active Segment: </label>
      <select
        v-model="activeSegmentIndex"
        @change="changeActiveSegment"
        class="segment-select"
      >
        <option v-for="i in 10" :key="i" :value="i">Segment {{ i }}</option>
      </select>
      <span
        class="segment-color-preview"
        :style="{ backgroundColor: getSegmentColorStyle(activeSegmentIndex) }"
      >
      </span>
      <span class="segment-label">{{
        getSegmentLabel(activeSegmentIndex)
      }}</span>
    </div>
  </div>

  <div class="wrapper">
    <div class="viewport-container">
      <div ref="elementRefAxial" class="viewport" />
      <canvas ref="canvasOverlayAxial" class="canvas-overlay" />
    </div>
    <div class="viewport-container">
      <div ref="elementRefSagittal" class="viewport" />
      <canvas ref="canvasOverlaySagittal" class="canvas-overlay" />
    </div>
    <div class="viewport-container">
      <div ref="elementRefCoronal" class="viewport" />
      <canvas ref="canvasOverlayCoronal" class="canvas-overlay" />
    </div>
  </div>

  <div class="frame-controls">
    <div class="viewport-selector">
      <label>Viewport:</label>
      <select
        v-model="selectedViewport"
        @change="onViewportChange"
        class="viewport-select"
      >
        <option value="axial">Axial</option>
        <option value="sagittal">Sagittal</option>
        <option value="coronal">Coronal</option>
      </select>
    </div>
    <button
      @click="previousFrame"
      :disabled="currentFrameIndex <= 0"
      class="frame-btn"
    >
      ← Prev
    </button>
    <div class="frame-slider-container">
      <input
        type="range"
        v-model.number="currentFrameIndex"
        @input="navigateToFrame(currentFrameIndex)"
        :min="0"
        :max="maxFrameIndex"
        class="frame-slider"
      />
      <span class="frame-info">
        Frame {{ currentFrameIndex + 1 }} / {{ totalFrames }}
      </span>
    </div>
    <button
      @click="nextFrame"
      :disabled="currentFrameIndex >= maxFrameIndex"
      class="frame-btn"
    >
      Next →
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import {
  RenderingEngine,
  Enums,
  volumeLoader,
  setVolumesForViewports,
  cache,
  metaData,
  geometryLoader,
  imageLoader,
} from "@cornerstonejs/core";
import { init as csCoreInit } from "@cornerstonejs/core";
import { init as dicomImageLoaderInit } from "@cornerstonejs/dicom-image-loader";
import {
  init as csToolsInit,
  ToolGroupManager,
  Enums as csToolsEnums,
  addTool,
  BrushTool,
  StackScrollTool,
  RectangleROITool,
  SplineROITool,
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

// Declare window.cv for TypeScript
declare global {
  interface Window {
    cv: any;
  }
}

const STORAGE_KEY = "mySegmentationData";
const CONTOURS_STORAGE_KEY = "savedContours";
let cvReady: any = null;
let savedContours = ref<any[]>([]);

const elementRefAxial = ref<HTMLDivElement | null>(null);
const elementRefSagittal = ref<HTMLDivElement | null>(null);
const elementRefCoronal = ref<HTMLDivElement | null>(null);
const canvasOverlayAxial = ref<HTMLCanvasElement | null>(null);
const canvasOverlaySagittal = ref<HTMLCanvasElement | null>(null);
const canvasOverlayCoronal = ref<HTMLCanvasElement | null>(null);
const running = ref(false);
const activeSegmentIndex = ref(1);
const currentFrameIndex = ref(0);
const totalFrames = ref(1);
const maxFrameIndex = computed(() => totalFrames.value - 1);
const selectedViewport = ref("axial");
const activeTool = ref("Brush");
let segmentationId = "MY_SEGMENTATION_ID";
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

let renderingEngine: RenderingEngine | null = null;
let toolGroup: any = null;
let volumeId: string | null = null;
let toolGroupId: string | null = null;
let viewportIdAxial = "CT_AXIAL";
let viewportIdSagittal = "CT_SAGITTAL";
let viewportIdCoronal = "CT_CORONAL";

// Get current viewport ID based on selection
const getCurrentViewportId = () => {
  switch (selectedViewport.value) {
    case "sagittal":
      return viewportIdSagittal;
    case "coronal":
      return viewportIdCoronal;
    default:
      return viewportIdAxial;
  }
};

// Calculate frame index from camera focal point
const calculateFrameIndexFromCamera = (viewport: any, viewportType: string) => {
  if (!viewport || !viewport.getCamera) return 0;

  const camera = viewport.getCamera();
  const currentVolume = cache.getVolume(volumeId);

  if (!currentVolume || !camera) return 0;

  const { spacing, origin, dimensions } = currentVolume;
  const { focalPoint } = camera;

  let frameIndex = 0;

  switch (viewportType) {
    case "sagittal":
      // X-axis: calculate frame from X position
      frameIndex = Math.round((focalPoint[0] - origin[0]) / spacing[0]);
      frameIndex = Math.max(0, Math.min(frameIndex, dimensions[0] - 1));
      break;
    case "coronal":
      // Y-axis: calculate frame from Y position
      frameIndex = Math.round((focalPoint[1] - origin[1]) / spacing[1]);
      frameIndex = Math.max(0, Math.min(frameIndex, dimensions[1] - 1));
      break;
    default:
      // Axial - Z-axis: calculate frame from Z position
      frameIndex = Math.round((focalPoint[2] - origin[2]) / spacing[2]);
      frameIndex = Math.max(0, Math.min(frameIndex, dimensions[2] - 1));
  }

  return frameIndex;
};

// Update frame count and index when viewport changes
const onViewportChange = () => {
  if (!renderingEngine) return;

  const viewport = renderingEngine.getViewport(getCurrentViewportId()) as any;
  if (!viewport) return;

  const currentVolume = cache.getVolume(volumeId);
  if (currentVolume && currentVolume.dimensions) {
    // Update total frames based on viewport orientation
    switch (selectedViewport.value) {
      case "sagittal":
        totalFrames.value = currentVolume.dimensions[0]; // X-axis
        break;
      case "coronal":
        totalFrames.value = currentVolume.dimensions[1]; // Y-axis
        break;
      default:
        totalFrames.value = currentVolume.dimensions[2]; // Z-axis (axial)
    }
  }

  // Update current frame index for the selected viewport
  currentFrameIndex.value = calculateFrameIndexFromCamera(
    viewport,
    selectedViewport.value
  );
};

// Frame navigation functions
const navigateToFrame = (frameIndex: number) => {
  if (!renderingEngine) return;

  const viewportId = getCurrentViewportId();
  const viewport = renderingEngine.getViewport(viewportId) as any;
  if (!viewport) return;

  // Ensure frame index is within bounds
  const targetFrame = Math.max(0, Math.min(frameIndex, maxFrameIndex.value));

  if (viewport.setImageIdIndex) {
    // For stack viewport
    viewport.setImageIdIndex(targetFrame);
  } else if (viewport.setCamera) {
    // For volume viewport - adjust focal point based on viewport orientation
    const camera = viewport.getCamera();
    const { position, viewUp } = camera;
    const currentVolume = cache.getVolume(volumeId);

    if (currentVolume) {
      const spacing = currentVolume.spacing;
      const origin = currentVolume.origin;
      const direction = currentVolume.direction;

      let newFocalPoint;
      switch (selectedViewport.value) {
        case "sagittal":
          // Move along X-axis
          newFocalPoint = [
            origin[0] + targetFrame * spacing[0],
            camera.focalPoint[1],
            camera.focalPoint[2],
          ];
          break;
        case "coronal":
          // Move along Y-axis
          newFocalPoint = [
            camera.focalPoint[0],
            origin[1] + targetFrame * spacing[1],
            camera.focalPoint[2],
          ];
          break;
        default:
          // Axial - move along Z-axis
          newFocalPoint = [
            camera.focalPoint[0],
            camera.focalPoint[1],
            origin[2] + targetFrame * spacing[2],
          ];
      }

      viewport.setCamera({
        focalPoint: newFocalPoint,
        position,
        viewUp,
      });
    }
  }

  viewport.render();
  currentFrameIndex.value = targetFrame;
};

const previousFrame = () => {
  if (currentFrameIndex.value > 0) {
    navigateToFrame(currentFrameIndex.value - 1);
  }
};

const nextFrame = () => {
  if (currentFrameIndex.value < maxFrameIndex.value) {
    navigateToFrame(currentFrameIndex.value + 1);
  }
};


const setupViewer = async () => {
  if (running.value) return;
  running.value = true;

  if (
    !elementRefAxial.value ||
    !elementRefSagittal.value ||
    !elementRefCoronal.value
  ) {
    return;
  }

  await csCoreInit();
  await dicomImageLoaderInit();
  await csToolsInit();

  // Load imageIds from WADO server
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

  // Generate unique IDs for this session
  volumeId = `CT_VOLUME_ID_${Date.now()}`;
  toolGroupId = `CT_TOOLGROUP_${Date.now()}`;
  
  // No need to check if volume exists since we're using unique IDs
  
  const volume = await volumeLoader.createAndCacheVolume(volumeId, {
    imageIds,
  });
  
  await volume.load();

  // Remove existing segmentation if it exists
  if (cache.getVolume(segmentationId)) {
    cache.removeVolumeLoadObject(segmentationId);
  }
  
  // Remove from segmentation state if exists
  const existingSegmentation = segmentation.state.getSegmentation(segmentationId);
  if (existingSegmentation) {
    segmentation.state.removeSegmentation(segmentationId);
  }

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

  // Add tools
  addTool(BrushTool);
  addTool(StackScrollTool);
  addTool(RectangleROITool);
  addTool(SplineROITool);  // Using SplineROITool instead of PlanarFreehandROITool for better performance

  // toolGroupId is already set above with unique timestamp
  toolGroup = ToolGroupManager.createToolGroup(toolGroupId);

  // Add tools to the tool group
  toolGroup.addTool(BrushTool.toolName);
  toolGroup.addTool(StackScrollTool.toolName);
  toolGroup.addTool(RectangleROITool.toolName);
  toolGroup.addTool(SplineROITool.toolName);

  // Activate BrushTool for drawing with primary mouse button (default)
  toolGroup.setToolActive(BrushTool.toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
  });

  // Activate StackScrollTool for frame navigation with mouse wheel
  toolGroup.setToolActive(StackScrollTool.toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Wheel }],
  });

  // Set annotation tools as passive initially
  toolGroup.setToolPassive(RectangleROITool.toolName);
  toolGroup.setToolPassive(SplineROITool.toolName);

  // Configure annotation tools for better performance
  const annotationRenderingOptions = {
    renderOutlineOnViewportEntry: true,
    allowOpenContours: true,
    preventHandleOutsideImage: false,
    calculatePointsInsideVolume: false
  };

  // Apply performance configurations
  toolGroup.setToolConfiguration(RectangleROITool.toolName, annotationRenderingOptions);
  
  // SplineROITool configuration for optimal polygon performance
  toolGroup.setToolConfiguration(SplineROITool.toolName, {
    // Basic performance settings
    renderAnnotationInProgress: true,
    preventHandleOutsideImage: false,
    calculatePointsInsideVolume: false,
    
    // Spline-specific optimizations
    resolution: 20,  // Lower resolution for faster rendering
    showControlPoints: true,  // Show control points for feedback
    controlPointRadius: 3,  // Small control points
    lineWidth: 1,  // Thin lines for performance
    
    // Disable expensive effects
    lineDash: [],
    shadow: false,
    
    // Interaction settings
    grabHandleThreshold: 5,
    handleRadius: 3,
    
    // Skip statistics for performance
    calculateStats: false
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

  // Initialize total frames after volume is loaded
  const loadedVolume = cache.getVolume(volumeId);
  if (loadedVolume && loadedVolume.dimensions) {
    // For axial view, the depth (z-axis) represents the number of frames
    totalFrames.value = loadedVolume.dimensions[2];
  }

  // Set up event listeners for frame changes on all viewports
  const handleCameraModified = () => {
    // Get the currently selected viewport
    const viewportId = getCurrentViewportId();
    const viewport = renderingEngine.getViewport(viewportId) as any;

    if (viewport) {
      // Calculate the current frame from camera position
      const newFrameIndex = calculateFrameIndexFromCamera(
        viewport,
        selectedViewport.value
      );

      // Update if different from current
      if (newFrameIndex !== currentFrameIndex.value) {
        currentFrameIndex.value = newFrameIndex;
      }
    }
  };

  // Listen for camera changes on all viewports
  const element = renderingEngine.getViewport(viewportIdAxial)?.element;
  if (element) {
    element.addEventListener(
      Enums.Events.CAMERA_MODIFIED,
      handleCameraModified
    );
  }

  const elementSag = renderingEngine.getViewport(viewportIdSagittal)?.element;
  if (elementSag) {
    elementSag.addEventListener(
      Enums.Events.CAMERA_MODIFIED,
      handleCameraModified
    );
  }

  const elementCor = renderingEngine.getViewport(viewportIdCoronal)?.element;
  if (elementCor) {
    elementCor.addEventListener(
      Enums.Events.CAMERA_MODIFIED,
      handleCameraModified
    );
  }

  // Setup frame change listeners for contour rendering
  setTimeout(() => {
    setupFrameChangeListener();
    setupAnnotationEventListeners();
  }, 500);
};

// Tool management functions
const setActiveTool = (toolName: string) => {
  if (!toolGroup) return;

  // First set all annotation tools to passive
  toolGroup.setToolPassive(BrushTool.toolName);
  toolGroup.setToolPassive(RectangleROITool.toolName);
  toolGroup.setToolPassive(SplineROITool.toolName);

  // Activate the selected tool
  switch (toolName) {
    case 'Brush':
      toolGroup.setToolActive(BrushTool.toolName, {
        bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
      });
      break;
    case 'Rectangle':
      toolGroup.setToolActive(RectangleROITool.toolName, {
        bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
      });
      break;
    case 'Polygon':
      toolGroup.setToolActive(SplineROITool.toolName, {
        bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
      });
      // Optimized configuration for SplineROITool
      toolGroup.setToolConfiguration(SplineROITool.toolName, {
        renderAnnotationInProgress: true,
        // Spline-specific settings for fast polygon creation
        resolution: 10,  // Very low resolution for instant feedback
        showControlPoints: true,
        controlPointRadius: 2,
        lineWidth: 1,
        // Performance settings
        calculateStats: false,
        calculatePointsInsideVolume: false,
        preventHandleOutsideImage: false,
        // Disable effects
        shadow: false,
        lineDash: []
      });
      
      // Force immediate render after configuration
      if (renderingEngine) {
        renderingEngine.render();
      }
      break;
  }

  activeTool.value = toolName;
  
  // Force immediate render when switching tools
  if (renderingEngine) {
    renderingEngine.render();
  }
  
  // Re-setup event listeners if switching to polygon
  if (toolName === 'Polygon') {
    setupAnnotationEventListeners();
  }
};

// Annotation management functions
const clearAnnotations = () => {
  if (!renderingEngine) return;

  try {
    // Clear all annotations from all viewports
    const annotationManager = annotation.state.getAnnotationManager();
    const annotations = annotationManager.getAllAnnotations();
    
    // Remove all annotations
    annotations.forEach((ann: any) => {
      annotationManager.removeAnnotation(ann.annotationUID);
    });
    
    // Re-render all viewports
    renderingEngine.render();
  } catch (error) {
    console.error('Error clearing annotations:', error);
  }
};

const saveAnnotations = () => {
  try {
    const annotationManager = annotation.state.getAnnotationManager();
    const annotations = annotationManager.getAllAnnotations();
    
    const annotationData = {
      timestamp: new Date().toISOString(),
      annotations: annotations.map((ann: any) => ({
        annotationUID: ann.annotationUID,
        data: ann.data,
        metadata: ann.metadata,
        toolName: ann.data?.toolName || 'unknown'
      }))
    };
    
    localStorage.setItem('savedAnnotations', JSON.stringify(annotationData));
    alert(`Saved ${annotations.length} annotations`);
  } catch (error) {
    console.error('Error saving annotations:', error);
    alert('Error saving annotations');
  }
};

const loadAnnotations = () => {
  try {
    const saved = localStorage.getItem('savedAnnotations');
    if (!saved) {
      alert('No saved annotations found');
      return;
    }
    
    const annotationData = JSON.parse(saved);
    const annotationManager = annotation.state.getAnnotationManager();
    
    // Clear existing annotations first
    clearAnnotations();
    
    // Add saved annotations
    annotationData.annotations.forEach((annData: any) => {
      // Restore annotation with original data
      annotationManager.addAnnotation({
        annotationUID: annData.annotationUID,
        data: annData.data,
        metadata: annData.metadata
      });
    });
    
    // Re-render all viewports
    if (renderingEngine) {
      renderingEngine.render();
    }
    
    alert(`Loaded ${annotationData.annotations.length} annotations`);
  } catch (error) {
    console.error('Error loading annotations:', error);
    alert('Error loading annotations');
  }
};

// Performance optimization: Throttle rendering updates
const throttle = (func: Function, limit: number) => {
  let inThrottle: boolean;
  return function(this: any, ...args: any[]) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  }
};

// Throttled render function for better performance during annotation creation
const throttledRender = throttle(() => {
  if (renderingEngine) {
    renderingEngine.render();
  }
}, 16); // ~60fps

// Setup annotation event listeners for performance optimization
const setupAnnotationEventListeners = () => {
  if (!renderingEngine) return;

  try {
    // Listen for annotation events on all viewports
    [viewportIdAxial, viewportIdSagittal, viewportIdCoronal].forEach(viewportId => {
      const viewport = renderingEngine!.getViewport(viewportId);
      if (viewport && viewport.element) {
        // Annotation completed - full render
        viewport.element.addEventListener('ANNOTATION_COMPLETED', () => {
          if (renderingEngine) renderingEngine.render();
        });

        // Annotation modified - immediate render for polygon tool
        viewport.element.addEventListener('ANNOTATION_MODIFIED', (evt: any) => {
          // Check if polygon tool is active for immediate rendering
          if (activeTool.value === 'Polygon') {
            if (renderingEngine) renderingEngine.render();
          } else {
            throttledRender();
          }
        });

        // Annotation selection - immediate render
        viewport.element.addEventListener('ANNOTATION_SELECTION_CHANGE', () => {
          if (renderingEngine) renderingEngine.render();
        });

        // Add mouse events for polygon tool immediate feedback
        viewport.element.addEventListener('mousedown', () => {
          if (activeTool.value === 'Polygon' && renderingEngine) {
            requestAnimationFrame(() => renderingEngine!.render());
          }
        });
        
        viewport.element.addEventListener('mousemove', () => {
          if (activeTool.value === 'Polygon' && renderingEngine) {
            requestAnimationFrame(() => renderingEngine!.render());
          }
        });
        
        // Add click event for polygon point addition
        viewport.element.addEventListener('click', () => {
          if (activeTool.value === 'Polygon' && renderingEngine) {
            // Immediate render on each polygon point
            renderingEngine.render();
            // Force synchronous render for this viewport
            viewport.render();
          }
        });
        
        // Add pointer events for even more responsive polygon drawing
        viewport.element.addEventListener('pointerdown', (evt: PointerEvent) => {
          if (activeTool.value === 'Polygon' && renderingEngine) {
            // Direct viewport render without going through rendering engine
            viewport.render();
          }
        });
        
        viewport.element.addEventListener('pointermove', (evt: PointerEvent) => {
          if (activeTool.value === 'Polygon' && renderingEngine) {
            // Use direct viewport render for faster updates
            viewport.render();
          }
        });
      }
    });
  } catch (error) {
    console.error('Error setting up annotation event listeners:', error);
  }
};

// Centralized segment color mapping - used for both UI and export
const segmentColorMap: { [key: number]: [number, number, number] } = {
  0: [0, 0, 0], // Background - transparent
  1: [255, 0, 0], // Red
  2: [0, 255, 0], // Green
  3: [0, 0, 255], // Blue
  4: [255, 255, 0], // Yellow
  5: [255, 0, 255], // Magenta
  6: [0, 255, 255], // Cyan
  7: [255, 128, 0], // Orange
  8: [128, 0, 255], // Purple
  9: [0, 128, 0], // Dark Green
  10: [128, 128, 128], // Gray
};

// Change active segment for drawing
const changeActiveSegment = async () => {
  segmentation.segmentIndex.setActiveSegmentIndex(
    segmentationId,
    activeSegmentIndex.value
  );
};

// Get current active segment
const getCurrentSegment = () => {
  return segmentation.segmentIndex.getActiveSegmentIndex(segmentationId) || 1;
};

// Get segment color for display
const getSegmentColorStyle = (index: number) => {
  const color = segmentColorMap[index];
  if (!color || index === 0) return "transparent";
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
};

// Get segment label
const getSegmentLabel = (index: number) => {
  const labels: { [key: number]: string } = {
    1: "Red",
    2: "Green",
    3: "Blue",
    4: "Yellow",
    5: "Magenta",
    6: "Cyan",
    7: "Orange",
    8: "Purple",
    9: "Dark Green",
    10: "Gray",
  };
  return labels[index] || "";
};

// Clear canvas helper
const clearCanvas = (canvas: HTMLCanvasElement | null) => {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
};

// Draw contours on canvas
const drawContourOnCanvas = (
  canvas: HTMLCanvasElement | null,
  contours: any[],
  color: string
) => {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  contours.forEach((contour) => {
    if (contour.points && contour.points.length > 0) {
      ctx.beginPath();
      contour.points.forEach((point: number[], idx: number) => {
        if (idx === 0) {
          ctx.moveTo(point[0], point[1]);
        } else {
          ctx.lineTo(point[0], point[1]);
        }
      });
      ctx.closePath();
      ctx.stroke();
    }
  });
};

// Render contours for a specific frame/slice
const renderContoursForFrame = (
  frameIndex: number,
  canvas: HTMLCanvasElement | null
) => {
  if (!canvas) return;

  const saved = localStorage.getItem("segmentationContours");
  if (!saved) {
    clearCanvas(canvas);
    return;
  }

  const data = JSON.parse(saved);

  // Set canvas dimensions if needed
  if (
    canvas.width !== data.dimensions.width ||
    canvas.height !== data.dimensions.height
  ) {
    canvas.width = data.dimensions.width;
    canvas.height = data.dimensions.height;
  }

  // Clear existing contours
  clearCanvas(canvas);

  // Find contours for this specific frame/slice
  const frameContours = data.sliceContours.find(
    (slice: any) => slice.frameNumber === frameIndex
  );

  if (!frameContours) {
    return; // No contours for this frame
  }

  // Draw all segments' contours for this frame
  frameContours.contours.forEach((segment: any) => {
    drawContourOnCanvas(canvas, segment.contours, segment.color);
  });
};

// Setup frame change listener for viewport
const setupFrameChangeListener = () => {
  if (!renderingEngine) return;

  try {
    const viewportAxial = renderingEngine.getViewport(viewportIdAxial);
    const viewportSagittal = renderingEngine.getViewport(viewportIdSagittal);
    const viewportCoronal = renderingEngine.getViewport(viewportIdCoronal);

    // Listen for image rendered events
    const handleImageRendered = (evt: any) => {
      const viewport = evt.detail.element
        ? renderingEngine.getViewport(evt.detail.viewportId)
        : evt.target;

      if (viewport === viewportAxial) {
        const frameIndex = viewport.getCurrentImageIdIndex
          ? viewport.getCurrentImageIdIndex()
          : currentFrameIndex.value;
        currentFrameIndex.value = frameIndex;
        renderContoursForFrame(frameIndex, canvasOverlayAxial.value);
      } else if (viewport === viewportSagittal) {
        // Handle sagittal view if needed
        const frameIndex = viewport.getCurrentImageIdIndex
          ? viewport.getCurrentImageIdIndex()
          : 0;
        renderContoursForFrame(frameIndex, canvasOverlaySagittal.value);
      } else if (viewport === viewportCoronal) {
        // Handle coronal view if needed
        const frameIndex = viewport.getCurrentImageIdIndex
          ? viewport.getCurrentImageIdIndex()
          : 0;
        renderContoursForFrame(frameIndex, canvasOverlayCoronal.value);
      }
    };

    // Add event listeners
    if (viewportAxial) {
      viewportAxial.element.addEventListener(
        "imagerendered",
        handleImageRendered
      );
    }
    if (viewportSagittal) {
      viewportSagittal.element.addEventListener(
        "imagerendered",
        handleImageRendered
      );
    }
    if (viewportCoronal) {
      viewportCoronal.element.addEventListener(
        "imagerendered",
        handleImageRendered
      );
    }
  } catch (error) {}
};

// Helper function to convert contours back to labelmap
const convertContoursToLabelmap = async (contoursData: any) => {
  const cv = await waitForOpenCV();
  const { dimensions, sliceContours } = contoursData;
  const { width, height, depth } = dimensions;
  const totalVoxels = width * height * depth;
  const scalarData = new Uint8Array(totalVoxels);

  // Process each slice with contours
  for (const sliceInfo of sliceContours) {
    const { sliceIndex, contours: segmentsList } = sliceInfo;
    const sliceStart = sliceIndex * width * height;

    // Create a mask for this slice
    const mask = new cv.Mat.zeros(height, width, cv.CV_8UC1);

    // Draw and fill each segment's contours
    for (const segmentData of segmentsList) {
      const segmentId = segmentData.segmentId || segmentData.segmentIndex || 1;
      const segmentContours = segmentData.contours;

      // Process each contour in this segment
      for (const contourObj of segmentContours) {
        const contourPoints = contourObj.points;
        if (!contourPoints || contourPoints.length < 3) continue;

        // Convert points to OpenCV format
        const points = [];
        for (const pt of contourPoints) {
          // Handle both [x,y] array format and {x,y} object format
          if (Array.isArray(pt)) {
            points.push(pt[0]);
            points.push(pt[1]);
          } else if (pt.x !== undefined && pt.y !== undefined) {
            points.push(pt.x);
            points.push(pt.y);
          }
        }

        if (points.length < 6) continue; // Need at least 3 points (6 values)

        const pointsMat = cv.matFromArray(
          points.length / 2,
          1,
          cv.CV_32SC2,
          points
        );

        const contourVector = new cv.MatVector();
        contourVector.push_back(pointsMat);

        // Fill the contour with the segment index value
        cv.fillPoly(mask, contourVector, new cv.Scalar(segmentId));

        pointsMat.delete();
        contourVector.delete();
      }
    }

    // Copy mask data to scalar array
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const maskValue = mask.ucharPtr(y, x)[0];
        const volumeIndex = sliceStart + y * width + x;
        scalarData[volumeIndex] = maskValue;
      }
    }

    mask.delete();
  }

  return scalarData;
};

const restoreSegmentation = async () => {
  // First check for saved contours (new approach)
  const savedContoursJson = localStorage.getItem("segmentationContours");

  if (savedContoursJson) {
    try {
      const contoursData = JSON.parse(savedContoursJson);

      // Convert contours to labelmap
      const scalarData = await convertContoursToLabelmap(contoursData);

      // Remove existing segmentation if it exists
      try {
        const existingSegmentation =
          segmentation.state.getSegmentation(segmentationId);
        if (existingSegmentation) {
          // Remove from tool group first
          const representations =
            segmentation.state.getSegmentationRepresentations(toolGroupId);
          for (const rep of representations || []) {
            if (rep.segmentationId === segmentationId) {
              await segmentation.removeSegmentationRepresentations(
                toolGroupId,
                {
                  segmentationId,
                  type: rep.type,
                }
              );
            }
          }
          // Remove the segmentation
          segmentation.state.removeSegmentation(segmentationId);
        }
      } catch (e) {
        // No existing segmentation to remove
      }

      // Remove the volume from cache if it exists
      try {
        const existingVolume = cache.getVolume(segmentationId);
        if (existingVolume) {
          cache.removeVolumeLoadObject(segmentationId);
        }
      } catch (e) {
        // No existing volume to remove
      }

      // Get the volume ID from the current volume
      const currentVolume = cache.getVolume(volumeId);
      if (!currentVolume) {
        return;
      }

      // Create a new derived labelmap volume
      await volumeLoader.createAndCacheDerivedLabelmapVolume(volumeId, {
        volumeId: segmentationId,
      });

      // Get the created volume and update its scalar data
      const newVolume = cache.getVolume(segmentationId);
      if (newVolume && newVolume.voxelManager) {
        // Set the scalar data using voxelManager
        const totalVoxels = scalarData.length;
        let nonZeroCount = 0;

        for (let i = 0; i < totalVoxels; i++) {
          if (scalarData[i] > 0) {
            newVolume.voxelManager.setAtIndex(i, scalarData[i]);
            nonZeroCount++;
          }
        }
      }

      // Add the segmentation
      await segmentation.addSegmentations([
        {
          segmentationId,
          representation: {
            type: csToolsEnums.SegmentationRepresentations.Labelmap,
            data: { volumeId: segmentationId },
          },
        },
      ]);

      // Add labelmap representation to viewport map (same as in setupViewer)
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

      // Clear any overlay canvases
      if (canvasOverlayAxial.value) clearCanvas(canvasOverlayAxial.value);
      if (canvasOverlaySagittal.value) clearCanvas(canvasOverlaySagittal.value);
      if (canvasOverlayCoronal.value) clearCanvas(canvasOverlayCoronal.value);

      // Render the viewports
      renderingEngine.render();
    } catch (error) {
      // Error restoring segmentation
    }
    return;
  }

  // Fallback to old segmentation restore
  const savedData = localStorage.getItem("mySegmentation");
  if (!savedData) {
    return;
  }
};

// Helper function to wait for OpenCV
const waitForOpenCV = async () => {
  // First ensure the imported cv is ready
  if (cvReady) {
    return cvReady;
  }

  try {
    // Wait for the imported cv module
    cvReady = await cv;
    return cvReady;
  } catch (error) {
    throw error;
  }
};

// Helper function to find contours from segmentation data
const findContoursFromSegmentation = async (
  sliceData: Uint8Array,
  width: number,
  height: number
) => {
  // Use the imported cv module
  const cv = cvReady;
  if (!cv) {
    throw new Error("OpenCV not initialized");
  }
  const contoursList = [];

  // Create Mat from slice data (single channel, grayscale)
  const src = new cv.Mat(height, width, cv.CV_8UC1);
  src.data.set(sliceData);

  // Process each segment (1-10)
  for (let segmentId = 1; segmentId <= 10; segmentId++) {
    const mask = new cv.Mat();

    // Create comparison mat for this segment value
    const comparisonMat = new cv.Mat(
      height,
      width,
      cv.CV_8UC1,
      new cv.Scalar(segmentId)
    );

    // Find pixels matching this segment
    cv.compare(src, comparisonMat, mask, cv.CMP_EQ);

    // Find contours
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(
      mask,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );

    // Extract contour points
    const segmentContours = [];
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const points = [];

      for (let j = 0; j < contour.data32S.length; j += 2) {
        points.push([contour.data32S[j], contour.data32S[j + 1]]);
      }

      if (points.length > 0) {
        segmentContours.push({
          id: `segment_${segmentId}_contour_${i}`,
          points: points,
        });
      }

      contour.delete();
    }

    // Add to results if contours found
    if (segmentContours.length > 0) {
      const color = segmentColorMap[segmentId];
      contoursList.push({
        segmentId: segmentId,
        color: `rgb(${color[0]}, ${color[1]}, ${color[2]})`,
        label: getSegmentLabel(segmentId),
        contours: segmentContours,
      });
    }

    // Cleanup
    contours.delete();
    hierarchy.delete();
    mask.delete();
    comparisonMat.delete();
  }

  src.delete();
  return contoursList;
};

const toSave2 = async () => {
  try {
    const time = new Date().getTime();

    // Wait for OpenCV to be ready
    const cv = await waitForOpenCV();

    // Get the segmentation state
    const segmentationState =
      segmentation.state.getSegmentation(segmentationId);
    if (!segmentationState) {
      return;
    }

    // Get the labelmap volume from cache
    const labelmapVolume = cache.getVolume(segmentationId);
    if (!labelmapVolume || !labelmapVolume.voxelManager) {
      return;
    }

    // Get volume dimensions
    const dimensions = labelmapVolume.dimensions;

    // Get scalar data using VoxelManager
    let scalarData;

    // Try getCompleteScalarDataArray first (preferred for Cornerstone3D 2.0)
    try {
      if (
        typeof labelmapVolume.voxelManager.getCompleteScalarDataArray ===
        "function"
      ) {
        scalarData = labelmapVolume.voxelManager.getCompleteScalarDataArray();
      }
    } catch (error) {
      // Silent fallback
    }

    // Fallback: Manually build the array using getAtIndex
    if (!scalarData) {
      const totalVoxels = dimensions[0] * dimensions[1] * dimensions[2];
      scalarData = new Uint8Array(totalVoxels);

      for (let i = 0; i < totalVoxels; i++) {
        try {
          const value = labelmapVolume.voxelManager.getAtIndex(i);
          scalarData[i] = typeof value === "number" ? value : 0;
        } catch (e) {
          scalarData[i] = 0;
        }
      }
    }

    // Process ALL slices that have segmentation data
    const width = dimensions[0];
    const height = dimensions[1];
    const depth = dimensions[2];
    const sliceSize = width * height;
    const allSliceContours = [];
    let processedSlices = 0;

    // Iterate through all slices
    for (let sliceIndex = 0; sliceIndex < depth; sliceIndex++) {
      const sliceStart = sliceIndex * sliceSize;

      // Extract slice data
      const sliceData = new Uint8Array(sliceSize);
      let hasSegmentation = false;

      for (let i = 0; i < sliceSize; i++) {
        const value = scalarData[sliceStart + i] || 0;
        sliceData[i] = value;
        if (value > 0) hasSegmentation = true;
      }

      // Only process slices that have segmentation data
      if (hasSegmentation) {
        // Find contours using OpenCV
        const contourResults = await findContoursFromSegmentation(
          sliceData,
          width,
          height
        );

        if (contourResults.length > 0) {
          allSliceContours.push({
            sliceIndex: sliceIndex,
            frameNumber: sliceIndex, // For DICOM frame reference
            contours: contourResults,
          });
          processedSlices++;
        }
      }
    }

    // Save all slice contours to localStorage
    localStorage.setItem(
      "segmentationContours",
      JSON.stringify({
        dimensions: { width, height, depth },
        sliceContours: allSliceContours,
        timestamp: new Date().toISOString(),
      })
    );

    // Log summary
    allSliceContours.forEach((slice) => {});

    return allSliceContours;
  } catch (error) {
    return [];
  }
};

const toSave = async () => {
  try {
    // Get the segmentation state
    const segmentationState =
      segmentation.state.getSegmentation(segmentationId);
    if (!segmentationState) {
      return;
    }

    // Get the labelmap volume from cache
    const labelmapVolume = cache.getVolume(segmentationId);
    if (!labelmapVolume || !labelmapVolume.voxelManager) {
      return;
    }

    // Get volume dimensions
    const dimensions = labelmapVolume.dimensions;

    // Get scalar data using VoxelManager
    let scalarData;

    // Try getCompleteScalarDataArray first (preferred for Cornerstone3D 2.0)
    try {
      if (
        typeof labelmapVolume.voxelManager.getCompleteScalarDataArray ===
        "function"
      ) {
        scalarData = labelmapVolume.voxelManager.getCompleteScalarDataArray();
      }
    } catch (error) {
      // Silent fallback
    }

    // Fallback: Manually build the array using getAtIndex
    if (!scalarData) {
      const totalVoxels = dimensions[0] * dimensions[1] * dimensions[2];
      scalarData = new Uint8Array(totalVoxels);

      for (let i = 0; i < totalVoxels; i++) {
        try {
          const value = labelmapVolume.voxelManager.getAtIndex(i);
          scalarData[i] = typeof value === "number" ? value : 0;
        } catch (e) {
          scalarData[i] = 0;
        }
      }
    }

    // Choose which slice to export (middle slice of axial view)
    const sliceIndex = Math.floor(dimensions[2] / 2);
    const width = dimensions[0];
    const height = dimensions[1];
    const sliceSize = width * height;
    const sliceStart = sliceIndex * sliceSize;

    // Extract slice data
    const sliceData = new Uint8Array(sliceSize);
    for (let i = 0; i < sliceSize; i++) {
      sliceData[i] = scalarData[sliceStart + i] || 0;
    }

    // Create canvas for visualization
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      return;
    }

    const imageData = ctx.createImageData(width, height);

    // Fill image data with segmentation colors using centralized color map
    for (let i = 0; i < sliceData.length; i++) {
      const segmentValue = sliceData[i];
      const color = segmentColorMap[segmentValue] || [128, 128, 128];
      const alpha = segmentValue > 0 ? 255 : 0; // Transparent for background

      const pixelIndex = i * 4;
      imageData.data[pixelIndex] = color[0]; // R
      imageData.data[pixelIndex + 1] = color[1]; // G
      imageData.data[pixelIndex + 2] = color[2]; // B
      imageData.data[pixelIndex + 3] = alpha; // A
    }

    ctx.putImageData(imageData, 0, 0);

    // Export as PNG blob and download
    canvas.toBlob((blob) => {
      if (!blob) {
        return;
      }

      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `segmentation_slice_${sliceIndex}.png`;
      a.click();

      // Clean up after a delay to allow download
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    }, "image/png");

    // Save segmentation data to localStorage for restoration
    localStorage.setItem(
      "savedSegmentation",
      JSON.stringify({
        segmentationId: segmentationState.segmentationId,
        scalarData: Array.from(scalarData),
        volumeMetadata: {
          dimensions: labelmapVolume.dimensions,
          spacing: labelmapVolume.spacing,
          origin: labelmapVolume.origin,
          direction: labelmapVolume.direction,
        },
        segments: segmentationState.segments,
      })
    );
  } catch (error) {}
};

// Keyboard event handler
const handleKeyDown = (event: KeyboardEvent) => {
  // Check if any input element is focused
  const activeElement = document.activeElement;
  if (
    activeElement &&
    (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA")
  ) {
    return; // Don't handle keys when typing in inputs
  }

  switch (event.key) {
    case "ArrowLeft":
    case "ArrowUp":
      event.preventDefault();
      previousFrame();
      break;
    case "ArrowRight":
    case "ArrowDown":
      event.preventDefault();
      nextFrame();
      break;
  }
};

onMounted(async () => {
  await setupViewer();

  // Initialize OpenCV
  try {
    cvReady = await cv;
  } catch (error) {
    // Failed to initialize OpenCV
  }

  // Add keyboard event listener
  window.addEventListener("keydown", handleKeyDown);
});

onUnmounted(() => {
  // Remove keyboard event listener
  window.removeEventListener("keydown", handleKeyDown);

  if (renderingEngine) {
    renderingEngine.destroy();
  }
  if (toolGroup && toolGroupId) {
    ToolGroupManager.destroyToolGroup(toolGroupId);
  }
  cache.purgeCache();
  running.value = false;
});
</script>

<style scoped>
.controls-container {
  margin-bottom: 20px;
  padding: 15px;
  background-color: #f5f5f5;
  border-radius: 8px;
}

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
  width: 100%;
  height: 100%;
  background-color: black;
}

.canvas-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 10;
}

.save,
.save-contours,
.restore {
  margin: 5px;
  padding: 10px;
  cursor: pointer;
  background-color: #4caf50;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 14px;
}

.save-contours {
  background-color: #2196f3;
}

.save:hover,
.restore:hover {
  background-color: #45a049;
}

.save-contours:hover {
  background-color: #0b7dda;
}

.segment-controls {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-left: 20px;
  padding: 10px;
  background-color: white;
  border-radius: 6px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.segment-controls label {
  font-weight: bold;
  color: #333;
}

.segment-select {
  padding: 5px 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
}

.segment-color-preview {
  display: inline-block;
  width: 30px;
  height: 30px;
  border: 2px solid #333;
  border-radius: 4px;
  vertical-align: middle;
}

.segment-label {
  font-size: 14px;
  font-weight: 500;
  color: #666;
  padding: 0 5px;
}


/* Frame Controls Styling */
.frame-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 15px;
  padding: 15px;
  background: #2a2a2a;
  border-radius: 8px;
  margin: 15px auto 10px;
  max-width: 800px;
}

.frame-btn {
  padding: 8px 16px;
  background: #3a3a3a;
  color: #ffffff !important;
  border: 1px solid #555;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.3s;
  min-width: 80px;
}

.frame-btn:hover:not(:disabled) {
  background: #4a4a4a;
  border-color: #666;
  color: #ffffff !important;
}

.frame-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  color: #999 !important;
}

.frame-slider-container {
  display: flex;
  align-items: center;
  gap: 15px;
  flex: 1;
  max-width: 500px;
}

.frame-slider {
  flex: 1;
  height: 6px;
  background: #3a3a3a;
  border-radius: 3px;
  outline: none;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}

.frame-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 20px;
  height: 20px;
  background: #4caf50;
  border-radius: 50%;
  cursor: pointer;
  transition: background 0.3s;
}

.frame-slider::-webkit-slider-thumb:hover {
  background: #66bb6a;
}

.frame-slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  background: #4caf50;
  border-radius: 50%;
  cursor: pointer;
  border: none;
  transition: background 0.3s;
}

.frame-slider::-moz-range-thumb:hover {
  background: #66bb6a;
}

.frame-info {
  color: #fff;
  font-size: 14px;
  min-width: 120px;
  text-align: center;
  background: #3a3a3a;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #555;
}

/* Viewport Selector Styling */
.viewport-selector {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-right: 15px;
}

.viewport-selector label {
  color: #fff;
  font-size: 14px;
  font-weight: 500;
}

.viewport-select {
  padding: 8px 12px;
  background: #3a3a3a;
  color: #fff;
  border: 1px solid #555;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.3s;
  min-width: 100px;
}

.viewport-select:hover {
  background: #4a4a4a;
  border-color: #666;
}

.viewport-select:focus {
  outline: none;
  border-color: #4caf50;
  box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.2);
}

/* Drawing Tools Styling */
.drawing-tools {
  display: inline-flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 15px;
  padding: 10px;
  background-color: white;
  border-radius: 6px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.drawing-tools label {
  font-weight: bold;
  color: #333;
  font-size: 14px;
}

.tool-buttons {
  display: flex;
  gap: 8px;
}

.tool-btn {
  padding: 8px 12px;
  border: 2px solid #ddd;
  border-radius: 6px;
  background-color: #f9f9f9;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 5px;
}

.tool-btn:hover {
  border-color: #4caf50;
  background-color: #f0f8f0;
}

.tool-btn.active {
  border-color: #4caf50;
  background-color: #e8f5e8;
  font-weight: bold;
  color: #2e7d32;
}

/* Annotation Controls Styling */
.annotation-controls {
  display: inline-flex;
  gap: 8px;
  margin: 0 15px;
  padding: 10px;
  background-color: #fff3e0;
  border-radius: 6px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.clear-btn {
  padding: 8px 12px;
  border: 2px solid #f44336;
  border-radius: 6px;
  background-color: #ffebee;
  color: #c62828;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.3s ease;
}

.clear-btn:hover {
  background-color: #f44336;
  color: white;
}

.save-annotations, .load-annotations {
  padding: 8px 12px;
  border: 2px solid #2196f3;
  border-radius: 6px;
  background-color: #e3f2fd;
  color: #1565c0;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.3s ease;
}

.save-annotations:hover, .load-annotations:hover {
  background-color: #2196f3;
  color: white;
}
</style>
