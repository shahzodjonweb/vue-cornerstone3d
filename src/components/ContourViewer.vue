<template>
  <div class="contour-viewer">
    <div class="controls">
      <div class="control-row">
        <button @click="convertToContour" :disabled="isConverting || !hasLabelmap" class="convert-btn">
          {{ isConverting ? `Converting... ${progress}%` : 'Convert Labelmap to Contour' }}
        </button>
        <button @click="removeContour" :disabled="!hasContour" class="remove-btn">
          Remove Contour
        </button>
      </div>
      
      <div class="control-row">
        <button @click="toggleLabelmapVisibility" :disabled="!hasLabelmap" class="toggle-btn">
          {{ labelmapVisible ? 'Hide Labelmap' : 'Show Labelmap' }}
        </button>
        <button @click="toggleContourVisibility" :disabled="!hasContour" class="toggle-btn">
          {{ contourVisible ? 'Hide Contour' : 'Show Contour' }}
        </button>
      </div>

      <div class="control-row">
        <label>Active Segment:</label>
        <select v-model="activeSegmentIndex" @change="changeActiveSegment">
          <option v-for="i in 10" :key="i" :value="i">
            Segment {{ i }}
          </option>
        </select>
      </div>
    </div>

    <div class="progress-bar" v-if="isConverting">
      <div class="progress-fill" :style="{ width: `${progress}%` }"></div>
    </div>

    <div class="info-panel">
      <h3>Segmentation Information</h3>
      <div class="info-grid">
        <div class="info-item">
          <span class="label">Status:</span>
          <span class="value">{{ status }}</span>
        </div>
        <div class="info-item">
          <span class="label">Total Segments:</span>
          <span class="value">{{ segmentCount }}</span>
        </div>
        <div class="info-item">
          <span class="label">Representation:</span>
          <span class="value">{{ representationType }}</span>
        </div>
        <div class="info-item">
          <span class="label">Active Segment:</span>
          <span class="value">{{ activeSegmentIndex }}</span>
        </div>
      </div>
    </div>

    <div class="instructions">
      <h4>Instructions:</h4>
      <ol>
        <li>Draw on the labelmap using the brush tool</li>
        <li>Click "Convert Labelmap to Contour" to convert</li>
        <li>Toggle visibility of representations as needed</li>
        <li>Use segment dropdown to work with different segments</li>
      </ol>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import {
  convertLabelmapToContour,
  removeContourRepresentation,
  toggleRepresentationVisibility,
  getSegmentationInfo,
  setupProgressListener,
  setActiveSegmentIndex,
  getActiveSegmentIndex,
} from '../utils/segmentationUtils';
import { Enums as csToolsEnums } from '@cornerstonejs/tools';

const props = defineProps<{
  volumeId: string;
  segmentationId: string;
  toolGroupId: string;
  viewportIds: string[];
}>();

const isConverting = ref(false);
const contourVisible = ref(true);
const labelmapVisible = ref(true);
const status = ref('Ready');
const segmentCount = ref(0);
const representationType = ref('None');
const hasLabelmap = ref(false);
const hasContour = ref(false);
const progress = ref(0);
const activeSegmentIndex = ref(1);

let progressCleanup: (() => void) | null = null;

onMounted(() => {
  updateSegmentationInfo();
  activeSegmentIndex.value = getActiveSegmentIndex(props.segmentationId);
  
  // Update info every 500ms to catch changes
  const intervalId = setInterval(() => {
    updateSegmentationInfo();
  }, 500);
  
  progressCleanup = setupProgressListener((progressInfo) => {
    progress.value = Math.round(progressInfo.progress);
    status.value = progressInfo.message;
  });
  
  onUnmounted(() => {
    clearInterval(intervalId);
  });
});

onUnmounted(() => {
  if (progressCleanup) {
    progressCleanup();
  }
});

watch(() => props.segmentationId, () => {
  updateSegmentationInfo();
});

function updateSegmentationInfo() {
  const info = getSegmentationInfo(props.toolGroupId, props.segmentationId);
  console.log('Segmentation info:', info);
  console.log('Tool group ID:', props.toolGroupId);
  console.log('Segmentation ID:', props.segmentationId);
  hasLabelmap.value = info.hasLabelmap;
  hasContour.value = info.hasContour;
  representationType.value = info.representationType;
  segmentCount.value = info.segmentCount;
}

async function convertToContour() {
  console.log('Convert button clicked');
  console.log('Has labelmap:', hasLabelmap.value);
  console.log('Tool group ID:', props.toolGroupId);
  console.log('Segmentation ID:', props.segmentationId);
  
  if (isConverting.value) {
    console.log('Already converting...');
    return;
  }
  
  if (!hasLabelmap.value) {
    console.log('No labelmap found, cannot convert');
    alert('Please draw on the image with the brush tool first!');
    return;
  }
  
  isConverting.value = true;
  progress.value = 0;
  status.value = 'Starting conversion...';

  try {
    const result = await convertLabelmapToContour(
      props.toolGroupId,
      props.segmentationId,
      {
        smoothing: {
          enabled: true,
          iterations: 3,
        },
        decimation: {
          enabled: true,
          targetReduction: 0.5,
        },
      }
    );

    if (result.success) {
      status.value = 'Conversion complete!';
      updateSegmentationInfo();
      console.log('Conversion successful!');
    } else {
      status.value = `Error: ${result.error}`;
      console.error('Conversion failed:', result.error);
    }
  } catch (error) {
    console.error('Error converting to contour:', error);
    status.value = `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    isConverting.value = false;
    progress.value = 0;
  }
}

async function removeContour() {
  if (!hasContour.value) return;
  
  status.value = 'Removing contour...';
  
  const result = await removeContourRepresentation(
    props.toolGroupId,
    props.segmentationId
  );
  
  if (result.success) {
    status.value = 'Contour removed';
    updateSegmentationInfo();
  } else {
    status.value = `Error: ${result.error}`;
  }
}

async function toggleContourVisibility() {
  if (!hasContour.value) return;
  
  contourVisible.value = !contourVisible.value;
  
  const result = await toggleRepresentationVisibility(
    props.toolGroupId,
    props.segmentationId,
    csToolsEnums.SegmentationRepresentations.Contour,
    contourVisible.value
  );
  
  if (result.success) {
    status.value = contourVisible.value ? 'Contour visible' : 'Contour hidden';
  } else {
    status.value = `Error: ${result.error}`;
  }
}

async function toggleLabelmapVisibility() {
  if (!hasLabelmap.value) return;
  
  labelmapVisible.value = !labelmapVisible.value;
  
  const result = await toggleRepresentationVisibility(
    props.toolGroupId,
    props.segmentationId,
    csToolsEnums.SegmentationRepresentations.Labelmap,
    labelmapVisible.value
  );
  
  if (result.success) {
    status.value = labelmapVisible.value ? 'Labelmap visible' : 'Labelmap hidden';
  } else {
    status.value = `Error: ${result.error}`;
  }
}

async function changeActiveSegment() {
  await setActiveSegmentIndex(props.segmentationId, activeSegmentIndex.value);
  status.value = `Active segment: ${activeSegmentIndex.value}`;
}

defineExpose({
  convertToContour,
  removeContour,
  updateSegmentationInfo,
});
</script>

<style scoped>
.contour-viewer {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  background: #1a1a1a;
  border-radius: 8px;
  margin-top: 1rem;
  max-width: 600px;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.control-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.control-row label {
  color: #ccc;
  margin-right: 0.5rem;
}

.control-row select {
  padding: 0.4rem;
  background: #2a2a2a;
  color: #fff;
  border: 1px solid #444;
  border-radius: 4px;
  cursor: pointer;
}

.convert-btn,
.remove-btn,
.toggle-btn {
  flex: 1;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.3s;
  font-size: 0.9rem;
}

.convert-btn {
  background: #4CAF50;
  color: white;
}

.convert-btn:hover:not(:disabled) {
  background: #45a049;
}

.remove-btn {
  background: #ff9800;
  color: white;
}

.remove-btn:hover:not(:disabled) {
  background: #e68900;
}

.toggle-btn {
  background: #2196F3;
  color: white;
}

.toggle-btn:hover:not(:disabled) {
  background: #0b7dda;
}

.convert-btn:disabled,
.remove-btn:disabled,
.toggle-btn:disabled {
  background: #666;
  cursor: not-allowed;
  opacity: 0.5;
}

.progress-bar {
  width: 100%;
  height: 20px;
  background: #2a2a2a;
  border-radius: 10px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4CAF50, #66BB6A);
  transition: width 0.3s ease;
}

.info-panel {
  background: #2a2a2a;
  padding: 1rem;
  border-radius: 4px;
  color: #ccc;
}

.info-panel h3 {
  margin: 0 0 0.75rem 0;
  color: #fff;
  font-size: 1rem;
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.info-item {
  display: flex;
  justify-content: space-between;
  padding: 0.25rem 0;
}

.info-item .label {
  color: #888;
  font-size: 0.85rem;
}

.info-item .value {
  color: #fff;
  font-weight: 500;
  font-size: 0.85rem;
}

.instructions {
  background: #252525;
  padding: 1rem;
  border-radius: 4px;
  color: #aaa;
}

.instructions h4 {
  margin: 0 0 0.5rem 0;
  color: #fff;
  font-size: 0.95rem;
}

.instructions ol {
  margin: 0;
  padding-left: 1.5rem;
  font-size: 0.85rem;
  line-height: 1.6;
}

.instructions li {
  margin: 0.25rem 0;
}
</style>