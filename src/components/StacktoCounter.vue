<template>
  <button @click="toSave" class="save">Save Segmentation</button>
  <button @click="restoreSegmentation" class="restore">
    Restore Segmentation
  </button>
  <button @click="convertToContour" class="convert">Convert to Contour</button>
  <div class="wrapper">
    <div ref="elementRefAxial" class="viewport" />
    <div ref="elementRefSagittal" class="viewport" />
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
  PlanarFreehandContourSegmentationTool,
  SplineContourSegmentationTool,
} from "@cornerstonejs/tools";
import { api } from "dicomweb-client";
import wadors from "@cornerstonejs/dicom-image-loader/wadors";
import * as polySeg from "@cornerstonejs/polymorphic-segmentation";
import setCtTransferFunctionForVolumeActor from "./StacktoCounterUtils/setCtTransferFunctionForVolumeActor.js";
import addManipulationBindings from "./StacktoCounterUtils/addManipulationBindings.ts";
import addSegmentIndexDropdown from "./StacktoCounterUtils/addSegmentIndexDropdown.ts";
// Local storage key
const STORAGE_KEY = "mySegmentationData";

const elementRefAxial = ref<HTMLDivElement | null>(null);
const elementRefSagittal = ref<HTMLDivElement | null>(null);
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

const setupViewer = async () => {
  if (running.value) return;
  running.value = true;

  if (!elementRefAxial.value || !elementRefSagittal.value) {
    console.error("Viewport DOM elements are missing");
    return;
  }

  await csCoreInit();
  await dicomImageLoaderInit();

  // Initialize tools with polySeg addon
  await csToolsInit({
    addons: {
      polySeg,
    },
  });

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

  addTool(BrushTool);
  addTool(PlanarFreehandContourSegmentationTool);
  addTool(SplineContourSegmentationTool);
  const toolGroupId = "CT_TOOLGROUP";
  toolGroup = ToolGroupManager.createToolGroup(toolGroupId);

  addManipulationBindings(toolGroup);
  toolGroup.addTool(BrushTool.toolName);
  toolGroup.addTool(PlanarFreehandContourSegmentationTool.toolName);
  toolGroup.addTool(SplineContourSegmentationTool.toolName);
  toolGroup.setToolActive(BrushTool.toolName, {
    bindings: [{ mouseButton: csToolsEnums.MouseBindings.Primary }],
  });

  toolGroup.addViewport(viewportIdAxial, renderingEngineId);
  toolGroup.addViewport(viewportIdSagittal, renderingEngineId);

  await setVolumesForViewports(
    renderingEngine,
    [{ volumeId, callback: setCtTransferFunctionForVolumeActor }],
    [viewportIdAxial, viewportIdSagittal]
  );

  await segmentation.addSegmentationRepresentations(viewportIdAxial, [
    {
      segmentationId,
      type: csToolsEnums.SegmentationRepresentations.Labelmap,
    },
  ]);

  renderingEngine.render();
};

const toSave = async () => {};

const restoreSegmentation = async () => {};

const convertToContour = async () => {
  // Add contour representation to both viewports
  //   await segmentation.addSegmentationRepresentations(viewportIdAxial, [
  //     {
  //       segmentationId,
  //       type: csToolsEnums.SegmentationRepresentations.Contour,
  //     },
  //   ]);

  await segmentation.addSegmentationRepresentations(viewportIdSagittal, [
    {
      segmentationId,
      type: csToolsEnums.SegmentationRepresentations.Contour,
    },
  ]);
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
.restore,
.convert {
  margin: 5px;
  padding: 10px;
  cursor: pointer;
}
</style>
