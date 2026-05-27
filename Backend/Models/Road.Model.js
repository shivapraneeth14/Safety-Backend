import mongoose from "mongoose";

const roadSchema = new mongoose.Schema({
  osmId: { type: Number, unique: true, index: true },
  name: String,
  highway: String,
  geometry: {
    type: { type: String, enum: ["LineString"], default: "LineString" },
    coordinates: { type: [[Number]] },
  },
  oneway: String,
  maxspeed: String,
  ref: String,
});

roadSchema.index({ geometry: "2dsphere" });

const Road = mongoose.model("Road", roadSchema);

export default Road;
