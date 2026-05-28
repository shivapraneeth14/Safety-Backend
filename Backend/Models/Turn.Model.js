import mongoose from "mongoose";

const turnSchema = new mongoose.Schema({
  osmId: { type: Number, index: true },
  location: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  type: {
    type: String,
    enum: [
      "t_junction", "y_junction", "cross", "offset_junction",
      "roundabout", "mini_roundabout", "slip_road",
      "slight_left", "left", "sharp_left", "hairpin_left",
      "slight_right", "right", "sharp_right", "hairpin_right",
      "gentle_curve_left", "gentle_curve_right",
      "s_curve", "reverse_s_curve",
      "blind_crest", "dip", "narrow_section",
      "dead_end", "complex",
      "straight", "slight_curve", "moderate_turn", "very_sharp_turn", "bend",
    ],
    required: true,
  },
  angle: { type: Number, default: 0 },
  riskLevel: { type: Number, min: 1, max: 5, default: 1 },
  isBlind: { type: Boolean, default: false },
  junctionCount: { type: Number, default: 0 },
  approachVectors: [{
    heading: Number,
    roadId: Number,
    roadName: String,
  }],
  speedLimit: Number,
  isOneWay: Boolean,
  laneCount: Number,
  roadWidth: Number,
  brakeCount: { type: Number, default: 0 },
  nearMissCount: { type: Number, default: 0 },
  roadName: String,
  highway: String,
  sightDistance: { type: Number, default: 100 },
  tags: { type: Map, of: String },
});

turnSchema.index({ location: "2dsphere" });
turnSchema.index({ osmId: 1, type: 1 });

const Turn = mongoose.model("Turn", turnSchema);
export default Turn;
