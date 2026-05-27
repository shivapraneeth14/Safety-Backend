import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import Road from "../Models/Road.Model.js";

dotenv.config();

const GEOJSON_PATH = "data/hyderabad-roads.geojson";
const BATCH_SIZE = 1000;

const DRIVING_HIGHWAYS = new Set([
  "motorway", "motorway_link",
  "trunk", "trunk_link",
  "primary", "primary_link",
  "secondary", "secondary_link",
  "tertiary", "tertiary_link",
  "residential", "service", "unclassified", "living_street", "road",
]);

async function importRoads() {
  console.log("🚀 Starting road import...");

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");

  const raw = fs.readFileSync(GEOJSON_PATH, "utf-8");
  const geojson = JSON.parse(raw);
  console.log(`📄 Loaded GeoJSON with ${geojson.features?.length || 0} features`);

  let imported = 0;
  let skipped = 0;
  let batch = [];

  for (const feature of geojson.features) {
    if (feature.geometry?.type !== "LineString") {
      skipped++;
      continue;
    }

    const props = feature.properties || {};
    const highway = props.highway;
    if (!highway || !DRIVING_HIGHWAYS.has(highway)) {
      skipped++;
      continue;
    }

    const osmId = typeof feature.id === "string"
      ? parseInt(feature.id.replace(/^\D+/, ""), 10)
      : feature.id;

    const coordinates = feature.geometry.coordinates;
    if (!coordinates || coordinates.length < 2) {
      skipped++;
      continue;
    }

    batch.push({
      updateOne: {
        filter: { osmId },
        update: {
          $set: {
            osmId,
            name: props.name || undefined,
            highway,
            geometry: {
              type: "LineString",
              coordinates,
            },
            oneway: props.oneway || undefined,
            maxspeed: props.maxspeed || undefined,
            ref: props.ref || undefined,
          },
        },
        upsert: true,
      },
    });

    if (batch.length >= BATCH_SIZE) {
      await Road.bulkWrite(batch);
      imported += batch.length;
      console.log(`  ✅ ${imported} roads imported (${skipped} skipped)`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await Road.bulkWrite(batch);
    imported += batch.length;
  }

  console.log(`\n📊 Summary:`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped:  ${skipped}`);

  await mongoose.disconnect();
  console.log("✅ Done!");
}

importRoads().catch((err) => {
  console.error("❌ Import failed:", err);
  process.exit(1);
});
