<template>
  <button @click="toSave" class="save">Save Segmentation</button>
  <button @click="restoreSegmentation" class="restore">
    Restore Segmentation
  </button>
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
import { v4 as uuidv4 } from "uuid";

// Local storage key
const STORAGE_KEY = "mySegmentationData";

const elementRefAxial = ref<HTMLDivElement | null>(null);
const elementRefSagittal = ref<HTMLDivElement | null>(null);
const elementRefCoronal = ref<HTMLDivElement | null>(null);
const running = ref(false);
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
  await volume.load();

  // Create an initial empty segmentation volume
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
  // const _value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "");

  // segmentation.state.removeSegmentation(segmentationId);
  // console.log(_value);
  // await segmentation.addSegmentations(_value);

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

function uint8ArrayToBase64(u8Arr: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([u8Arr]);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
function uint8ArrayToBase64(u8Arr: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([u8Arr]);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
const toSave = async () => {
  const segmentations = segmentation.state.getSegmentations();
  const segmentationInfo = segmentations[0];
  const segmentationId = segmentationInfo.segmentationId;
  const segVolume = cache.getVolume(segmentationId);
  const scalarData = segVolume.voxelManager.getCompleteScalarDataArray();
  const dataToStore = {
    segmentationId,
    representationData: segmentationInfo.representationData,
    segments: segmentationInfo.representationData.Labelmap.segments,
    imageIds: segmentationInfo.representationData.Labelmap.imageIds,
    scalarData: Array.from(scalarData),
    volumeMetadata: {
      dimensions: segVolume.dimensions,
      spacing: segVolume.spacing,
      origin: segVolume.origin,
      direction: segVolume.direction,
    },
  };
  localStorage.setItem("savedSegmentation", JSON.stringify(dataToStore));
  console.log(localStorage.getItem("savedSegmentation"));
  // localStorage.setItem("savedSegmentation", JSON.stringify(dataToStore));
};

const restoreSegmentation = async () => {
  const saved = localStorage.getItem("savedSegmentation");
  if (!saved) {
    console.warn("⛔ Segmentatsiya topilmadi!");
    return;
  }

  const data = JSON.parse(saved);
  const {
    segmentationId,
    scalarData,
    volumeMetadata,
    imageIds,
    segments,
    representationData,
  } = data;

  // 1. Volume (labelmap) ni cache ga qayta joylash
  cache.putVolume(segmentationId, {
    ...volumeMetadata,
    scalarData: new Uint8Array(scalarData),
    metadata: {},
    imageIds,
  });

  // 2. Segmentatsiyani add qilish
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

  // 3. Uni barcha viewportlarga ulang
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

  segmentation.setActiveSegmentation(segmentationId);
};

onMounted(async () => {
  await setupViewer();
  // restoreSegmentation();
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
}
</style>
