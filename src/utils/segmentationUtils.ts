import {
  eventTarget,
  Enums,
} from '@cornerstonejs/core';
import {
  Enums as csToolsEnums,
  segmentation,
} from '@cornerstonejs/tools';

export interface ConversionProgress {
  progress: number;
  message: string;
}

export function setupProgressListener(
  onProgress: (progress: ConversionProgress) => void
) {
  const listener = (evt: any) => {
    if (evt.detail.type === csToolsEnums.WorkerTypes.SURFACE_CLIPPING) {
      const { progress } = evt.detail;
      onProgress({
        progress: progress * 100,
        message: `Converting: ${Math.round(progress * 100)}%`
      });
    }
  };

  eventTarget.addEventListener(Enums.Events.WEB_WORKER_PROGRESS, listener);
  
  return () => {
    eventTarget.removeEventListener(Enums.Events.WEB_WORKER_PROGRESS, listener);
  };
}

export async function convertLabelmapToContour(
  toolGroupId: string,
  segmentationId: string,
  _options?: {
    smoothing?: {
      enabled: boolean;
      iterations?: number;
    };
    decimation?: {
      enabled: boolean;
      targetReduction?: number;
    };
  }
) {
  try {
    // First check if labelmap exists
    const representations = segmentation.state.getSegmentationRepresentations(toolGroupId);
    const hasLabelmap = representations?.some(
      rep => rep.segmentationId === segmentationId && 
      rep.type === csToolsEnums.SegmentationRepresentations.Labelmap
    );

    if (!hasLabelmap) {
      throw new Error('No labelmap representation found to convert');
    }

    // Add contour representation to the same tool group
    await segmentation.addSegmentationRepresentations(toolGroupId, [
      {
        segmentationId,
        type: csToolsEnums.SegmentationRepresentations.Contour,
      },
    ]);
    
    return { success: true };
  } catch (error) {
    console.error('Conversion failed:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

export async function removeContourRepresentation(
  toolGroupId: string,
  segmentationId: string
) {
  try {
    await segmentation.removeSegmentationRepresentations(toolGroupId, {
      segmentationId,
      type: csToolsEnums.SegmentationRepresentations.Contour,
    });
    
    return { success: true };
  } catch (error) {
    console.error('Remove contour failed:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

export async function toggleRepresentationVisibility(
  toolGroupId: string,
  segmentationId: string,
  representationType: csToolsEnums.SegmentationRepresentations,
  visible: boolean
) {
  const representations = segmentation.state.getSegmentationRepresentations(toolGroupId);
  const targetRep = representations?.find(
    rep => rep.segmentationId === segmentationId && 
    rep.type === representationType
  );

  if (targetRep && 'segmentationRepresentationUID' in targetRep) {
    const repUID = (targetRep as any).segmentationRepresentationUID;
    
    await segmentation.config.visibility.setSegmentationRepresentationVisibility(
      toolGroupId,
      repUID,
      visible
    );
    
    return { success: true };
  }
  
  return { 
    success: false, 
    error: 'Representation not found' 
  };
}

export function getSegmentationInfo(
  toolGroupId: string,
  segmentationId: string
) {
  const segmentationData = segmentation.state.getSegmentation(segmentationId);
  const representations = segmentation.state.getSegmentationRepresentations(toolGroupId);
  
  const hasLabelmap = representations?.some(
    rep => rep.segmentationId === segmentationId && 
    rep.type === csToolsEnums.SegmentationRepresentations.Labelmap
  );
  
  const hasContour = representations?.some(
    rep => rep.segmentationId === segmentationId && 
    rep.type === csToolsEnums.SegmentationRepresentations.Contour
  );
  
  const segments = segmentationData?.segments;
  const segmentCount = segments ? Object.keys(segments).length : 0;
  
  let representationType = 'None';
  if (hasLabelmap && hasContour) {
    representationType = 'Labelmap + Contour';
  } else if (hasLabelmap) {
    representationType = 'Labelmap';
  } else if (hasContour) {
    representationType = 'Contour';
  }
  
  return {
    hasLabelmap,
    hasContour,
    representationType,
    segmentCount,
    segments,
  };
}

export async function setActiveSegmentIndex(
  segmentationId: string,
  segmentIndex: number
) {
  segmentation.segmentIndex.setActiveSegmentIndex(segmentationId, segmentIndex);
}

export function getActiveSegmentIndex(segmentationId: string): number {
  return segmentation.segmentIndex.getActiveSegmentIndex(segmentationId) || 1;
}