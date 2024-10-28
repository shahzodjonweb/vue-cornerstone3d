<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { createImageIdsAndCacheMetaData, initDemo } from '../lib'
import { 
  RenderingEngine, 
  Enums, 
  type Types, 
  volumeLoader, 
  cornerstoneStreamingImageVolumeLoader 
} from '@cornerstonejs/core'

// Register volume loader
volumeLoader.registerUnknownVolumeLoader(cornerstoneStreamingImageVolumeLoader)

// Create refs
const elementRef = ref<HTMLDivElement | null>(null)
const running = ref(false)

// Setup function
const setup = async () => {
  if (running.value) {
    return
  }
  running.value = true
  await initDemo()

  // Get Cornerstone imageIds and fetch metadata into RAM
  const imageIds = await createImageIdsAndCacheMetaData({
    StudyInstanceUID: '1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463',
    SeriesInstanceUID: '1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561',
    wadoRsRoot: 'https://d3t6nz73ql33tx.cloudfront.net/dicomweb',
  })

  // Instantiate a rendering engine
  const renderingEngineId = 'myRenderingEngine'
  const renderingEngine = new RenderingEngine(renderingEngineId)
  const viewportId = 'CT_STACK'

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
  const viewport = renderingEngine.getViewport(viewportId) as Types.IVolumeViewport

  // Define a volume in memory
  const volumeId = 'streamingImageVolume'
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
