import mongoose from "mongoose";

const turningEventSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  location: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  headingBefore: Number,
  headingAfter: Number,
  angleChange: Number,
  speed: Number,
  turnType: String,
  roadId: Number,
  timestamp: { type: Date, default: Date.now },
});

turningEventSchema.index({ location: "2dsphere" });
turningEventSchema.index({ timestamp: -1 });
// FIX ISSUE #34: roadId indexed for faster junction queries
turningEventSchema.index({ roadId: 1 });

const TurningEvent = mongoose.model("TurningEvent", turningEventSchema);
export default TurningEvent;
