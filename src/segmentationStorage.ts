import { openDB } from "idb";

const DB_NAME = "SegmentationDB";
const STORE_NAME = "segmentations";

export async function getDB() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    },
  });
}

export async function saveSegmentationToIndexedDB(data: any) {
  const db = await getDB();
  await db.put(STORE_NAME, data, "savedSegmentation");
}

export async function getSegmentationFromIndexedDB() {
  const db = await getDB();
  return await db.get(STORE_NAME, "savedSegmentation");
}

export async function saveContourDataToIndexedDB(contourData: any, segmentationId: string) {
  const db = await getDB();
  const key = `contour_${segmentationId}`;
  await db.put(STORE_NAME, contourData, key);
  console.log(`Contour data saved with key: ${key}`);
}

export async function getContourDataFromIndexedDB(segmentationId: string) {
  const db = await getDB();
  const key = `contour_${segmentationId}`;
  const data = await db.get(STORE_NAME, key);
  console.log(`Contour data retrieved with key: ${key}`, data);
  return data;
}

export async function getAllContourKeys() {
  const db = await getDB();
  const allKeys = await db.getAllKeys(STORE_NAME);
  return allKeys.filter(key => String(key).startsWith('contour_'));
}
