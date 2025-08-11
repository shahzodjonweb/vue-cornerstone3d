import { imageLoader, metaData } from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';

// Cache to store parsed DICOM data
const dicomDataCache = new Map<string, any>();

// Store for multi-frame DICOM data
interface MultiFrameDicomData {
  dataSet: any;
  pixelDataElement: any;
  numberOfFrames: number;
  rows: number;
  columns: number;
  pixelSpacing: number[];
  sliceThickness: number;
  windowCenter: number;
  windowWidth: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  bitsAllocated: number;
  bitsStored: number;
  highBit: number;
  pixelRepresentation: number;
  photometricInterpretation: string;
  samplesPerPixel: number;
}

// Store parsed DICOM data
export function storeDicomData(fileId: string, data: MultiFrameDicomData) {
  dicomDataCache.set(fileId, data);
}

// Get stored DICOM data
function getDicomData(fileId: string): MultiFrameDicomData | undefined {
  return dicomDataCache.get(fileId);
}

// Extract frame pixel data from multi-frame DICOM
function extractFramePixelData(
  dataSet: any,
  pixelDataElement: any,
  frameIndex: number,
  rows: number,
  columns: number,
  bitsAllocated: number,
  samplesPerPixel: number
): ArrayBuffer {
  const bytesPerPixel = bitsAllocated / 8;
  const frameSize = rows * columns * bytesPerPixel * samplesPerPixel;
  
  // Get the pixel data from the dataSet's byteArray
  const pixelData = dataSet.byteArray;
  if (!pixelData) {
    throw new Error('No pixel data byteArray found in dataSet');
  }
  
  const offset = pixelDataElement.dataOffset;
  
  // Calculate frame offset
  const frameOffset = offset + (frameIndex * frameSize);
  
  
  // Extract frame data
  const frameData = new Uint8Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
    if (frameOffset + i < pixelData.length) {
      frameData[i] = pixelData[frameOffset + i];
    } else {
      // Pixel data truncated
      break;
    }
  }
  
  return frameData.buffer;
}

// Custom image loader for multi-frame DICOM
function multiFrameDicomImageLoader(imageId: string): Types.IImageLoadObject {
  // Create a promise that will resolve with the image
  const promise = new Promise<Types.IImage>(async (resolve, reject) => {
    try {
      // Parse the imageId to get file ID and frame number
      // Format: multiframe:fileId:frame
      const parts = imageId.split(':');
      if (parts.length !== 3 || parts[0] !== 'multiframe') {
        throw new Error(`Invalid imageId format: ${imageId}`);
      }
      
      const fileId = parts[1];
      const frameIndex = parseInt(parts[2], 10);
      
      // Get cached DICOM data
      const dicomData = getDicomData(fileId);
      if (!dicomData) {
        throw new Error(`DICOM data not found for fileId: ${fileId}`);
      }
      
      const {
        dataSet,
        pixelDataElement,
        numberOfFrames,
        rows,
        columns,
        pixelSpacing,
        sliceThickness,
        windowCenter,
        windowWidth,
        rescaleSlope,
        rescaleIntercept,
        bitsAllocated,
        bitsStored,
        highBit,
        pixelRepresentation,
        photometricInterpretation,
        samplesPerPixel
      } = dicomData;
      
      // Validate frame index
      if (frameIndex < 0 || frameIndex >= numberOfFrames) {
        throw new Error(`Invalid frame index: ${frameIndex} (total frames: ${numberOfFrames})`);
      }
      
      // Extract pixel data for this frame
      const framePixelData = extractFramePixelData(
        dataSet,
        pixelDataElement,
        frameIndex,
        rows,
        columns,
        bitsAllocated,
        samplesPerPixel
      );
      
      // Create typed array based on bits allocated
      let pixelDataTypedArray: Uint8Array | Uint16Array | Int16Array;
      
      if (bitsAllocated === 8) {
        pixelDataTypedArray = new Uint8Array(framePixelData);
      } else if (bitsAllocated === 16) {
        // For 16-bit data, we need to handle byte order correctly
        // DICOM is typically little-endian, but let's create the array properly
        const uint8Array = new Uint8Array(framePixelData);
        const pixelCount = uint8Array.length / 2;
        
        if (pixelRepresentation === 0) {
          pixelDataTypedArray = new Uint16Array(pixelCount);
          for (let i = 0; i < pixelCount; i++) {
            // Little-endian: low byte first, high byte second
            pixelDataTypedArray[i] = uint8Array[i * 2] | (uint8Array[i * 2 + 1] << 8);
          }
        } else {
          pixelDataTypedArray = new Int16Array(pixelCount);
          for (let i = 0; i < pixelCount; i++) {
            // Little-endian: low byte first, high byte second
            const unsigned = uint8Array[i * 2] | (uint8Array[i * 2 + 1] << 8);
            // Convert to signed 16-bit
            pixelDataTypedArray[i] = unsigned > 32767 ? unsigned - 65536 : unsigned;
          }
        }
      } else {
        throw new Error(`Unsupported bits allocated: ${bitsAllocated}`);
      }
      
      
      // Calculate min and max pixel values
      let minPixelValue = Number.MAX_VALUE;
      let maxPixelValue = Number.MIN_VALUE;
      
      for (let i = 0; i < pixelDataTypedArray.length; i++) {
        const value = pixelDataTypedArray[i];
        if (value < minPixelValue) minPixelValue = value;
        if (value > maxPixelValue) maxPixelValue = value;
      }
      
      
      // Determine if image is color
      const isColor = photometricInterpretation === 'RGB' || samplesPerPixel > 1;
      
      // Apply windowing validation - ensure values are reasonable
      let finalWindowCenter = windowCenter;
      let finalWindowWidth = windowWidth;
      
      // Calculate reasonable windowing if the provided values seem extreme
      const pixelRange = maxPixelValue - minPixelValue;
      const rescaledMin = minPixelValue * rescaleSlope + rescaleIntercept;
      const rescaledMax = maxPixelValue * rescaleSlope + rescaleIntercept;
      const rescaledRange = rescaledMax - rescaledMin;
      
      // If windowing seems unreasonable compared to pixel data, recalculate
      if (!finalWindowCenter || !finalWindowWidth || 
          finalWindowWidth > rescaledRange * 3 || 
          finalWindowCenter < rescaledMin - rescaledRange ||
          finalWindowCenter > rescaledMax + rescaledRange) {
        
        finalWindowCenter = (rescaledMin + rescaledMax) / 2;
        finalWindowWidth = rescaledRange * 1.2; // Add some padding
        
      }
      
      // Create the image object
      const image: Types.IImage = {
        imageId,
        minPixelValue,
        maxPixelValue,
        slope: rescaleSlope,
        intercept: rescaleIntercept,
        windowCenter: finalWindowCenter,
        windowWidth: finalWindowWidth,
        rows,
        columns,
        height: rows,
        width: columns,
        color: isColor,
        rgba: false,
        // numComps: samplesPerPixel, // Not part of IImage interface
        render: undefined, // Will be set by Cornerstone
        columnPixelSpacing: pixelSpacing[0],
        rowPixelSpacing: pixelSpacing[1],
        sliceThickness,
        invert: photometricInterpretation === 'MONOCHROME1',
        sizeInBytes: pixelDataTypedArray.byteLength,
        getPixelData: () => pixelDataTypedArray,
        getCanvas: undefined as any, // Optional, not needed for basic functionality
        decodeTimeInMS: 0,
        loadTimeInMS: 0,
        numberOfComponents: samplesPerPixel,
        dataType: bitsAllocated === 8 ? 'Uint8Array' : 'Uint16Array',
        
        // Additional properties that might be needed
        // data: undefined, // Not part of IImage interface
        sharedCacheKey: undefined,
        // hasPixelSpacing: true, // Not part of IImage interface
        // isPreScaled: false, // Not part of IImage interface
        
        // Frame-specific metadata
        // frameNumber: frameIndex, // Not part of IImage interface
        // instanceNumber: frameIndex + 1, // Not part of IImage interface
        // imagePositionPatient: [0, 0, frameIndex * sliceThickness], // Not part of IImage interface
        // imageOrientationPatient: [1, 0, 0, 0, 1, 0], // Not part of IImage interface
        
        // Reference to original data
        cachedLut: undefined,
        voiLUTFunction: 'LINEAR' as any,
      };
      
      
      resolve(image);
    } catch (error) {
      reject(error);
    }
  });
  
  // Return the ImageLoadObject
  return {
    promise,
    cancelFn: undefined,
    decache: undefined
  };
}

// Register metadata provider for multi-frame DICOM
function multiFrameMetadataProvider(type: string, imageId: string): any {
  // Parse the imageId
  const parts = imageId.split(':');
  if (parts.length !== 3 || parts[0] !== 'multiframe') {
    return undefined;
  }
  
  const fileId = parts[1];
  const frameIndex = parseInt(parts[2], 10);
  
  const dicomData = getDicomData(fileId);
  if (!dicomData) {
    return undefined;
  }
  
  // Return metadata based on type
  switch (type) {
    case 'imagePixelModule':
      return {
        samplesPerPixel: dicomData.samplesPerPixel,
        photometricInterpretation: dicomData.photometricInterpretation,
        rows: dicomData.rows,
        columns: dicomData.columns,
        bitsAllocated: dicomData.bitsAllocated,
        bitsStored: dicomData.bitsStored,
        highBit: dicomData.highBit,
        pixelRepresentation: dicomData.pixelRepresentation,
        planarConfiguration: dicomData.dataSet.uint16('x00280006'),
        pixelAspectRatio: '1:1',
      };
    
    case 'modalityLutModule':
      return {
        rescaleIntercept: dicomData.rescaleIntercept,
        rescaleSlope: dicomData.rescaleSlope,
        rescaleType: 'HU',
      };
    
    case 'voiLutModule':
      return {
        windowCenter: [dicomData.windowCenter],
        windowWidth: [dicomData.windowWidth],
      };
    
    case 'imagePlaneModule':
      return {
        pixelSpacing: dicomData.pixelSpacing,
        sliceThickness: dicomData.sliceThickness,
        sliceLocation: frameIndex * dicomData.sliceThickness,
        imagePositionPatient: [0, 0, frameIndex * dicomData.sliceThickness],
        imageOrientationPatient: [1, 0, 0, 0, 1, 0],
        columns: dicomData.columns,
        rows: dicomData.rows,
      };
    
    case 'generalImageModule':
      return {
        instanceNumber: frameIndex + 1,
      };
    
    case 'generalSeriesModule':
      return {
        modality: dicomData.dataSet.string('x00080060') || 'CT',
        seriesInstanceUID: dicomData.dataSet.string('x0020000e') || `series_${fileId}`,
        seriesNumber: dicomData.dataSet.intString('x00200011') || 1,
      };
    
    case 'generalStudyModule':
      return {
        studyInstanceUID: dicomData.dataSet.string('x0020000d') || `study_${fileId}`,
        studyDate: dicomData.dataSet.string('x00080020') || '',
        studyTime: dicomData.dataSet.string('x00080030') || '',
      };
    
    case 'patientModule':
      return {
        patientName: dicomData.dataSet.string('x00100010') || 'Anonymous',
        patientId: dicomData.dataSet.string('x00100020') || 'Unknown',
      };
    
    default:
      return undefined;
  }
}

// Initialize the custom loader
export function initializeMultiFrameLoader() {
  // Register the image loader
  imageLoader.registerImageLoader('multiframe', multiFrameDicomImageLoader);
  
  // Register the metadata provider with high priority
  metaData.addProvider(multiFrameMetadataProvider, 10000);
  
}

// Clean up function
export function cleanupMultiFrameLoader() {
  dicomDataCache.clear();
}