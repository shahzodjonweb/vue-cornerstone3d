import { api } from 'dicomweb-client';
import * as cornerstoneWADOImageLoader from '@cornerstonejs/dicom-image-loader';

const StudyInstanceUID = '1.3.6.1.4.1.14519.5.2.1.7009.2403.334240657131972136850343327463';
const SeriesInstanceUID = '1.3.6.1.4.1.14519.5.2.1.7009.2403.226151125820845824875394858561';
const wadoRsRoot = 'https://d14fa38qiwhyfd.cloudfront.net/dicomweb';

export async function initDemo(): Promise<string[]> {
  const dicomClient = new api.DICOMwebClient({
    url: wadoRsRoot,
    singlepart: true,
  });

  const instances = await dicomClient.retrieveSeriesMetadata({
    studyInstanceUID: StudyInstanceUID,
    seriesInstanceUID: SeriesInstanceUID,
  });

  const SOP_INSTANCE_UID = '00080018';
  const SERIES_INSTANCE_UID = '0020000E';

  const imageIds = instances.map((instance: any) => {
    const sopUID = instance[SOP_INSTANCE_UID]?.Value?.[0];
    const seriesUID = instance[SERIES_INSTANCE_UID]?.Value?.[0];

    const imageId = `wadors:${wadoRsRoot}/studies/${StudyInstanceUID}/series/${seriesUID}/instances/${sopUID}/frames/1`;
    
    // Add metadata for the image
    cornerstoneWADOImageLoader.wadors.metaDataManager.add(imageId, instance);
    
    return imageId;
  });

  return imageIds;
}