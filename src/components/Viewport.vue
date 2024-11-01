<script setup lang="ts">
import { ref, onMounted } from "vue"
import {
  RenderingEngine,
  Enums,
  type Types,
  volumeLoader,
  cornerstoneStreamingImageVolumeLoader,
} from "@cornerstonejs/core"
import { init as csRenderInit, cache } from '@cornerstonejs/core';
import { init as csToolsInit } from '@cornerstonejs/tools';
import { init as dicomImageLoaderInit } from '@cornerstonejs/dicom-image-loader';
import { api } from 'dicomweb-client';
import cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';

// Register volume loader
volumeLoader.registerUnknownVolumeLoader(cornerstoneStreamingImageVolumeLoader)

// Create refs
const elementRef = ref<HTMLDivElement | null>(null)
const running = ref(false)

async function createImageIdsAndCacheMetaData({
  StudyInstanceUID,
  SeriesInstanceUID,
  SOPInstanceUID = null,
  wadoRsRoot,
  client = null,
}) {
  const SOP_INSTANCE_UID = "00080018"
  const SERIES_INSTANCE_UID = "0020000E"

  const studySearchOptions = {
    studyInstanceUID: StudyInstanceUID,
    seriesInstanceUID: SeriesInstanceUID,
  }

  client =
    client ||
    new api.DICOMwebClient({ url: wadoRsRoot as string, singlepart: true })
  const instances = await client.retrieveSeriesMetadata(studySearchOptions)
  const imageIds = instances.map((instanceMetaData) => {
    const SeriesInstanceUID = instanceMetaData[SERIES_INSTANCE_UID].Value[0]
    const SOPInstanceUIDToUse =
      SOPInstanceUID || instanceMetaData[SOP_INSTANCE_UID].Value[0]

    const prefix = "wadors:"

    const imageId =
      prefix +
      wadoRsRoot +
      "/studies/" +
      StudyInstanceUID +
      "/series/" +
      SeriesInstanceUID +
      "/instances/" +
      SOPInstanceUIDToUse +
      "/frames/1"

    cornerstoneDICOMImageLoader.wadors.metaDataManager.add(
      imageId,
      instanceMetaData
    )
    return imageId
  })

  // we don't want to add non-pet
  // Note: for 99% of scanners SUV calculation is consistent bw slices

  return imageIds
}

// Setup function
const setup = async () => {
  if (running.value) {
    return
  }
  running.value = true
  await csRenderInit()
  await csToolsInit()
  dicomImageLoaderInit({ maxWebWorkers: 1 })

  // Get Cornerstone imageIds and fetch metadata into RAM
  const imageIds = await createImageIdsAndCacheMetaData({
    StudyInstanceUID:
      "1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463",
    SeriesInstanceUID:
      "1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561",
    wadoRsRoot: "https://d3t6nz73ql33tx.cloudfront.net/dicomweb",
  })

  // Instantiate a rendering engine
  const renderingEngineId = "myRenderingEngine"
  const renderingEngine = new RenderingEngine(renderingEngineId)
  const viewportId = "CT_STACK"

  const viewportInput = {
    viewportId,
    type: Enums.ViewportType.ORTHOGRAPHIC,
    element: elementRef.value,
    defaultOptions: {
      orientation: Enums.OrientationAxis.SAGITTAL,
    },
  }

  renderingEngine.enableElement(viewportInput)

  // Get the viewport
  const viewport = renderingEngine.getViewport(
    viewportId
  ) as Types.IVolumeViewport

  // Define a volume in memory
  const volumeId = "streamingImageVolume"
  const volume = await volumeLoader.createAndCacheVolume(volumeId, {
    imageIds,
  })

  // Set the volume to load
  volume.load()

  // Set the volume on the viewport
  viewport.setVolumes([{ volumeId }])

  // Render the image
  viewport.render()
}

// Run setup on mount
onMounted(() => {
  setup()
})
</script>

<template>
  <div
    ref="elementRef"
    style="width: 512px; height: 512px; background-color: #000"
  ></div>
</template>
