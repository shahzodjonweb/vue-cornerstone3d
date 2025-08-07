<template>
  <div class="controls-container">
    <button @click="toSave" class="save">Save Segmentation</button>
    <button @click="restoreSegmentation" class="restore">
      Restore Segmentation
    </button>
    
    <div class="segment-controls">
      <label>Active Segment: </label>
      <select v-model="activeSegmentIndex" @change="changeActiveSegment" class="segment-select">
        <option v-for="i in 10" :key="i" :value="i">
          Segment {{ i }}
        </option>
      </select>
      <span class="segment-color-preview" 
            :style="{ backgroundColor: getSegmentColorStyle(activeSegmentIndex) }">
      </span>
      <span class="segment-label">{{ getSegmentLabel(activeSegmentIndex) }}</span>
    </div>
  </div>
  
  <div class="wrapper">
    <div ref="elementRefAxial" class="viewport" />
    <div ref="elementRefSagittal" class="viewport" />
    <div ref="elementRefCoronal" class="viewport" />
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
const running = ref(false);
const activeSegmentIndex = ref(1);
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

let renderingEngine: RenderingEngine;
let toolGroup: any;
let volumeId: string;
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

  volumeId = "CT_VOLUME_ID";
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
};

// Centralized segment color mapping - used for both UI and export
const segmentColorMap: { [key: number]: [number, number, number] } = {
  0: [0, 0, 0],           // Background - transparent
  1: [255, 0, 0],         // Red
  2: [0, 255, 0],         // Green
  3: [0, 0, 255],         // Blue
  4: [255, 255, 0],       // Yellow
  5: [255, 0, 255],       // Magenta
  6: [0, 255, 255],       // Cyan
  7: [255, 128, 0],       // Orange
  8: [128, 0, 255],       // Purple
  9: [0, 128, 0],         // Dark Green
  10: [128, 128, 128]     // Gray
};

// Change active segment for drawing
const changeActiveSegment = async () => {
  segmentation.segmentIndex.setActiveSegmentIndex(
    segmentationId, 
    activeSegmentIndex.value
  );
  console.log(`Active segment changed to: ${activeSegmentIndex.value}`);
};

// Get current active segment
const getCurrentSegment = () => {
  return segmentation.segmentIndex.getActiveSegmentIndex(segmentationId) || 1;
};

// Get segment color for display
const getSegmentColorStyle = (index: number) => {
  const color = segmentColorMap[index];
  if (!color || index === 0) return 'transparent';
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
};

// Get segment label
const getSegmentLabel = (index: number) => {
  const labels: { [key: number]: string } = {
    1: 'Red',
    2: 'Green',
    3: 'Blue',
    4: 'Yellow',
    5: 'Magenta',
    6: 'Cyan',
    7: 'Orange',
    8: 'Purple',
    9: 'Dark Green',
    10: 'Gray'
  };
  return labels[index] || '';
};

const restoreSegmentation = async () => {
  const savedData = localStorage.getItem("mySegmentation");
  if (!savedData) {
    console.warn("Segmentatsiya topilmadi!");
    return;
  }
  console.log(JSON.parse(savedData));
};

const toSave = async () => {
  try {
    console.log("Starting toSave function...");
    
    // Get the segmentation state
    const segmentationState = segmentation.state.getSegmentation(segmentationId);
    console.log("Segmentation state:", segmentationState);

    if (!segmentationState) {
      console.error("No segmentation found");
      return;
    }

    // Get the labelmap representation data
    const labelmapData = segmentationState.representationData?.Labelmap;
    console.log("Labelmap data:", labelmapData);

    if (!labelmapData) {
      console.error("No labelmap data found", segmentationState.representationData);
      return;
    }

    // Get the volumeId - handle both volume and stack types
    let volumeId: string | null = null;
    
    if (labelmapData && typeof labelmapData === 'object') {
      if ('volumeId' in labelmapData && labelmapData.volumeId) {
        volumeId = labelmapData.volumeId as string;
      } else {
        // Use the segmentation ID as volume ID
        volumeId = segmentationId;
      }
    }

    console.log("Volume ID:", volumeId);

    if (!volumeId) {
      console.error("No volume ID found");
      return;
    }

    // Get the labelmap volume from cache
    const labelmapVolume = cache.getVolume(volumeId);
    console.log("Labelmap volume:", labelmapVolume);

    if (!labelmapVolume) {
      console.error("Labelmap volume not found in cache");
      return;
    }

    // Get volume dimensions and data
    const dimensions = labelmapVolume.dimensions;
    console.log("Dimensions:", dimensions);
    
    // Get scalar data using VoxelManager properly
    let scalarData;
    
    if (!labelmapVolume.voxelManager) {
      console.error("No voxelManager found in labelmap volume");
      return;
    }
    
    // Try different methods to get scalar data
    try {
      // Method 1: Try getCompleteScalarDataArray() (Cornerstone3D 2.0)
      if (typeof labelmapVolume.voxelManager.getCompleteScalarDataArray === 'function') {
        scalarData = labelmapVolume.voxelManager.getCompleteScalarDataArray();
        console.log("Got scalar data using getCompleteScalarDataArray()");
      }
    } catch (error) {
      console.log("getCompleteScalarDataArray failed, trying alternative methods...");
    }
    
    // Method 2: Try getScalarData with error handling
    if (!scalarData) {
      try {
        scalarData = labelmapVolume.voxelManager.getScalarData();
        console.log("Got scalar data using getScalarData()");
      } catch (error) {
        console.log("getScalarData failed, building array manually...");
      }
    }
    
    // Method 3: Manually build the array using getAtIndex
    if (!scalarData) {
      const totalVoxels = dimensions[0] * dimensions[1] * dimensions[2];
      const Constructor = labelmapVolume.voxelManager.getConstructor() || Uint8Array;
      scalarData = new Constructor(totalVoxels);
      
      console.log("Building scalar data manually from voxels...");
      let hasAnySegmentation = false;
      
      for (let i = 0; i < totalVoxels; i++) {
        try {
          const value = labelmapVolume.voxelManager.getAtIndex(i);
          // Handle RGB values if returned
          const numValue = typeof value === 'number' ? value : (value as any)?.r || 0;
          scalarData[i] = numValue;
          if (numValue > 0) hasAnySegmentation = true;
        } catch (e) {
          scalarData[i] = 0;
        }
      }
      
      if (!hasAnySegmentation) {
        console.warn("No segmentation data found - the labelmap is empty. Draw something first!");
      }
    }
    
    console.log("Scalar data length:", scalarData?.length);

    // Choose which slice to export (middle slice of axial view)
    const sliceIndex = Math.floor(dimensions[2] / 2);
    const width = dimensions[0];
    const height = dimensions[1];
    const sliceSize = width * height;

    // Extract slice data - convert ArrayLike to array if needed
    const sliceStart = sliceIndex * sliceSize;
    const sliceEnd = sliceStart + sliceSize;
    const sliceData = new Uint8Array(sliceSize);
    
    // Copy slice data from the scalar data
    for (let i = 0; i < sliceSize; i++) {
      sliceData[i] = scalarData[sliceStart + i] || 0;
    }

    // Create canvas for visualization
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      console.error("Could not get canvas context");
      return;
    }

    const imageData = ctx.createImageData(width, height);

    // Fill image data with segmentation colors using centralized color map
    for (let i = 0; i < sliceData.length; i++) {
      const segmentValue = sliceData[i];
      const color = segmentColorMap[segmentValue] || [128, 128, 128];
      const alpha = segmentValue > 0 ? 255 : 0; // Transparent for background

      const pixelIndex = i * 4;
      imageData.data[pixelIndex] = color[0];     // R
      imageData.data[pixelIndex + 1] = color[1]; // G
      imageData.data[pixelIndex + 2] = color[2]; // B
      imageData.data[pixelIndex + 3] = alpha;    // A
    }

    ctx.putImageData(imageData, 0, 0);

    // Export as PNG blob and download
    canvas.toBlob((blob) => {
      if (!blob) {
        console.error("Failed to create blob");
        return;
      }

      const url = URL.createObjectURL(blob);
      console.log("Segmentation image blob URL:", url);
      console.log("Blob size:", blob.size, "bytes");
      console.log("Blob type:", blob.type);

      const a = document.createElement("a");
      a.href = url;
      a.download = `segmentation_slice_${sliceIndex}.png`;
      a.click();

      // Clean up after a delay to allow download
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    }, "image/png");

    // Also save the full segmentation data to localStorage for restoration
    const segmentationData = {
      segmentationId: segmentationState.segmentationId,
      representationData: segmentationState.representationData,
      segments: segmentationState.segments,
    };

    localStorage.setItem("savedSegmentation", JSON.stringify(segmentationData));
    console.log("Segmentation saved to localStorage and exported as PNG");
    
  } catch (error) {
    console.error("Error saving segmentation:", error);
  }
};

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

.viewport {
  width: 512px;
  height: 512px;
  background-color: black;
}

.save,
.restore {
  margin: 5px;
  padding: 10px;
  cursor: pointer;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 14px;
}

.save:hover,
.restore:hover {
  background-color: #45a049;
}

.segment-controls {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-left: 20px;
  padding: 10px;
  background-color: white;
  border-radius: 6px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
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
</style>
