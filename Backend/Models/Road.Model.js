import mongoose from "mongoose";

const roadSchema = new mongoose.Schema({
  osmId: { type: Number, unique: true, index: true },
  name: String,
  highway: String,
  nodes: [Number],
  geometry: {
    type: { type: String, enum: ["LineString"], default: "LineString" },
    coordinates: { type: [[Number]] },
  },
  oneway: String,
  maxspeed: String,
  ref: String,
  lanes: String,
  width: String,
  surface: String,
  junction: String,
  // FIX ISSUE #8: osmAgeDays tracks how old the OSM data is for confidence calculation
  osmAgeDays: { type: Number, default: 365 },
});

roadSchema.index({ geometry: "2dsphere" });

const Road = mongoose.model("Road", roadSchema);
export default Road;
