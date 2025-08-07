<template>
  <div class="container">
    <div class="controls">
      <h3>Labelmap to Contour</h3>
      
      <div class="tool-section">
        <button 
          @click="setTool('brush')" 
          :class="{ active: currentTool === 'brush' }"
        >
          Brush Tool
        </button>
        <button 
          @click="setTool('eraser')" 
          :class="{ active: currentTool === 'eraser' }"
        >
          Eraser
        </button>
      </div>

      <div class="tool-section">
        <label>Brush Size: {{ brushSize }}</label>
        <input 
          type="range" 
          v-model="brushSize" 
          min="5" 
          max="50"
          @input="changeBrushSize"
        />
      </div>

      <button @click="convertToContour" class="convert-btn">
        Convert to Contour
      </button>
      
      <button @click="clearAll" class="clear-btn">
        Clear All
      </button>
      
      <div class="info-section">
        <p>Left: Draw labelmap</p>
        <p>Right: Contour result</p>
      </div>
    </div>

    <div class="viewports-container">
      <div class="viewport-wrapper">
        <h4>Labelmap (AXIAL)</h4>
        <div ref="element1" class="viewport" />
      </div>
      <div class="viewport-wrapper">
        <h4>Contour (SAGITTAL)</h4>
        <div ref="element2" class="viewport" />
      </div>
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
  PanTool,
  ZoomTool,
  WindowLevelTool,
  PlanarFreehandContourSegmentationTool,
  SplineContourSegmentationTool,
} from "@cornerstonejs/tools";
import * as cornerstoneTools from "@cornerstonejs/tools";
import * as polySeg from "@cornerstonejs/polymorphic-segmentation";
import { api } from "dicomweb-client";
import wadors from "@cornerstonejs/dicom-image-loader/wadors";

// DOM refs
const element1 = ref<HTMLDivElement | null>(null);
const element2 = ref<HTMLDivElement | null>(null);

// State
const currentTool = ref("brush");
const brushSize = ref(15);

// IDs - exact match with example
const renderingEngineId = "myRenderingEngine";
const volumeId = "cornerstoneStreamingImageVolume:CT_VOLUME_ID";
const segmentationId = "MY_SEGMENTATION_ID";
const toolGroupId = "ToolGroup_MPR";
const toolGroupId2 = "ToolGroup_3D";
const viewportId1 = "CT_LEFT";
const viewportId2 = "CT_RIGHT";

// DICOM config
const StudyInstanceUID = "1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463";
const SeriesInstanceUID = "1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561";
const wadoRsRoot = "https://d14fa38qiwhyfd.cloudfront.net/dicomweb";

let renderingEngine: RenderingEngine;
let toolGroup1: any;
let toolGroup2: any;

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

async function run() {
  if (!element1.value || !element2.value) {
    console.error("Viewport DOM elements are missing");
    return;
  }

  // Initialize
  await csCoreInit();
  await dicomImageLoaderInit();
  await csToolsInit({
    addons: {
      polySeg,
    },
  });

  // Add tools
  cornerstoneTools.addTool(BrushTool);
  cornerstoneTools.addTool(PlanarFreehandContourSegmentationTool);
  cornerstoneTools.addTool(SplineContourSegmentationTool);
  cornerstoneTools.addTool(PanTool);
  cornerstoneTools.addTool(ZoomTool);
  cornerstoneTools.addTool(WindowLevelTool);

  // Create tool groups
  toolGroup1 = ToolGroupManager.createToolGroup(toolGroupId);
  toolGroup2 = ToolGroupManager.createToolGroup(toolGroupId2);

  // Add navigation tools to both groups
  toolGroup1.addTool(PanTool.toolName);
  toolGroup1.addTool(ZoomTool.toolName);
  toolGroup1.addTool(WindowLevelTool.toolName);
  
  toolGroup2.addTool(PanTool.toolName);
  toolGroup2.addTool(ZoomTool.toolName);
  toolGroup2.addTool(WindowLevelTool.toolName);

  // Add segmentation tools
  toolGroup1.addTool(BrushTool.toolName);
  toolGroup2.addTool(PlanarFreehandContourSegmentationTool.toolName);
  toolGroup2.addTool(SplineContourSegmentationTool.toolName);

  // Set navigation bindings for both groups
  toolGroup1.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Auxiliary }],
  });
  toolGroup1.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Secondary }],
  });

  toolGroup2.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Auxiliary }],
  });
  toolGroup2.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Secondary }],
  });

  // Set active tools
  toolGroup1.setToolActive(BrushTool.toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
  });

  toolGroup2.setToolActive(PlanarFreehandContourSegmentationTool.toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
  });

  // Get image IDs
  const imageIds = await createImageIdsAndCacheMetaData();

  // Create volume
  const volume = await volumeLoader.createAndCacheVolume(volumeId, {
    imageIds,
  });

  // Create rendering engine
  renderingEngine = new RenderingEngine(renderingEngineId);

  // Setup viewports
  const viewportInputArray = [
    {
      viewportId: viewportId1,
      type: Enums.ViewportType.ORTHOGRAPHIC,
      element: element1.value,
      defaultOptions: {
        orientation: Enums.OrientationAxis.AXIAL,
      },
    },
    {
      viewportId: viewportId2,
      type: Enums.ViewportType.ORTHOGRAPHIC,
      element: element2.value,
      defaultOptions: {
        orientation: Enums.OrientationAxis.SAGITTAL,
      },
    },
  ];

  renderingEngine.setViewports(viewportInputArray);

  // Add viewports to tool groups
  toolGroup1.addViewport(viewportId1, renderingEngineId);
  toolGroup2.addViewport(viewportId2, renderingEngineId);

  // Load volume
  volume.load();

  // Set volumes on viewports
  await setVolumesForViewports(
    renderingEngine,
    [{ volumeId }],
    [viewportId1, viewportId2]
  );

  // Create derived segmentation volume
  await volumeLoader.createAndCacheDerivedVolume(volumeId, {
    volumeId: segmentationId,
  });

  // Add segmentation to state
  await segmentation.addSegmentations([
    {
      segmentationId,
      representation: {
        type: csToolsEnums.SegmentationRepresentations.Labelmap,
        data: {
          volumeId: segmentationId,
        },
      },
    },
  ]);

  // Add labelmap representation to first viewport
  await segmentation.addSegmentationRepresentations(toolGroupId, [
    {
      segmentationId,
      type: csToolsEnums.SegmentationRepresentations.Labelmap,
    },
  ]);

  // Render
  renderingEngine.renderViewports([viewportId1, viewportId2]);
  console.log("Setup complete!");
}

function setTool(tool: string) {
  if (!toolGroup1) return;
  
  currentTool.value = tool;
  
  if (tool === 'brush') {
    toolGroup1.setToolConfiguration(BrushTool.toolName, {
      activeStrategy: 'FILL_INSIDE',
    });
    console.log('Switched to brush mode');
  } else if (tool === 'eraser') {
    toolGroup1.setToolConfiguration(BrushTool.toolName, {
      activeStrategy: 'ERASE',
    });
    console.log('Switched to eraser mode');
  }
}

function changeBrushSize() {
  if (!toolGroup1) return;
  
  toolGroup1.setToolConfiguration(BrushTool.toolName, {
    brushSize: brushSize.value,
  });
}

async function convertToContour() {
  try {
    console.log("Converting to contour...");
    
    // Add contour representation to second viewport
    await segmentation.addSegmentationRepresentations(toolGroupId2, [
      {
        segmentationId,
        type: csToolsEnums.SegmentationRepresentations.Contour,
      },
    ]);
    
    console.log("Successfully converted to contour!");
    
    renderingEngine.renderViewports([viewportId2]);
    
  } catch (error) {
    console.error("Error converting to contour:", error);
  }
}

async function clearAll() {
  if (!confirm("Clear all segmentations?")) return;
  
  try {
    // Remove all representations
    const reps1 = segmentation.state.getSegmentationRepresentations(toolGroupId);
    const reps2 = segmentation.state.getSegmentationRepresentations(toolGroupId2);
    
    if (reps1 && reps1.length > 0) {
      for (const rep of reps1) {
        await segmentation.removeSegmentationRepresentation(
          toolGroupId,
          (rep as any).segmentationRepresentationUID
        );
      }
    }
    
    if (reps2 && reps2.length > 0) {
      for (const rep of reps2) {
        await segmentation.removeSegmentationRepresentation(
          toolGroupId2,
          (rep as any).segmentationRepresentationUID
        );
      }
    }
    
    // Remove segmentation
    segmentation.state.removeSegmentation(segmentationId);
    
    // Create new segmentation
    await volumeLoader.createAndCacheDerivedVolume(volumeId, {
      volumeId: segmentationId,
    });

    // Re-add segmentation
    await segmentation.addSegmentations([
      {
        segmentationId,
        representation: {
          type: csToolsEnums.SegmentationRepresentations.Labelmap,
          data: {
            volumeId: segmentationId,
          },
        },
      },
    ]);

    // Re-add labelmap to first viewport
    await segmentation.addSegmentationRepresentations(toolGroupId, [
      {
        segmentationId,
        type: csToolsEnums.SegmentationRepresentations.Labelmap,
      },
    ]);

    renderingEngine.render();
    console.log("Cleared all segmentations");
  } catch (error) {
    console.error("Error clearing:", error);
  }
}

onMounted(async () => {
  await run();
});

onUnmounted(() => {
  if (renderingEngine) {
    renderingEngine.destroy();
  }
  if (toolGroup1) {
    ToolGroupManager.destroyToolGroup(toolGroupId);
  }
  if (toolGroup2) {
    ToolGroupManager.destroyToolGroup(toolGroupId2);
  }
  cache.purgeCache();
});
</script>

<style scoped>
.container {
  display: flex;
  height: 100vh;
  background: #000;
}

.controls {
  width: 250px;
  padding: 20px;
  background: #1a1a1a;
  color: white;
}

.controls h3 {
  margin: 0 0 20px 0;
  color: #4CAF50;
}

.tool-section {
  margin-bottom: 20px;
}

.tool-section button {
  display: block;
  width: 100%;
  padding: 10px;
  margin-bottom: 10px;
  background: #333;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.tool-section button:hover {
  background: #444;
}

.tool-section button.active {
  background: #4CAF50;
}

.tool-section label {
  display: block;
  margin-bottom: 5px;
  color: #ccc;
}

.tool-section input[type="range"] {
  width: 100%;
}

.convert-btn,
.clear-btn {
  width: 100%;
  padding: 12px;
  margin-bottom: 10px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
}

.convert-btn {
  background: #2196F3;
  color: white;
}

.convert-btn:hover {
  background: #1976D2;
}

.clear-btn {
  background: #f44336;
  color: white;
}

.clear-btn:hover {
  background: #d32f2f;
}

.info-section {
  margin-top: 20px;
  padding: 10px;
  background: #2a2a2a;
  border-radius: 4px;
}

.info-section p {
  margin: 5px 0;
  font-size: 12px;
  color: #aaa;
}

.viewports-container {
  flex: 1;
  display: flex;
  gap: 20px;
  padding: 20px;
  align-items: center;
  justify-content: center;
}

.viewport-wrapper {
  text-align: center;
}

.viewport-wrapper h4 {
  color: white;
  margin: 0 0 10px 0;
}

.viewport {
  width: 500px;
  height: 500px;
  border: 2px solid #333;
  background: black;
}
</style>