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
});

roadSchema.index({ geometry: "2dsphere" });

const Road = mongoose.model("Road", roadSchema);
export default Road;
