import bcrypt from "bcrypt"
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import User from "../Models/User.Model.js";

async function generateBothToken(userid) {
    try {
        const user = await User.findById(userid);
        if (!user) {
            console.error(`generateBothToken: User not found for id ${userid}`);
            throw new Error("User not found");
        }

        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();

        console.log(`generateBothToken: Tokens generated for user ${userid}`);
        return { accessToken, refreshToken };
    } catch (error) {
        console.error("generateBothToken error:", error);
        throw new Error("Error generating tokens");
    }
}

const verifyToken = (token, secret) => {
    try {
        return jwt.verify(token, secret);
    } catch {
        return null;
    }
};

// FIX ISSUE #27: JWT verification middleware for protected routes
const verifyJWT = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    req.user = await User.findById(decoded._id).select("-password -refreshToken");
    if (!req.user) {
      return res.status(401).json({ message: "User not found" });
    }
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

const register = async (req, res) => {
  const { username, email, password, phoneNumber, vehicleType } = req.body;

  console.log("backend", req.body);

  try {
    if (!username || !email || !password) {
      return res.status(400).json({ message: "Please provide username, email, and password" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists with this email" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      phoneNumber: phoneNumber || undefined,
      vehicleType: vehicleType || "two-wheeler",
    });

    const accessToken = newUser.generateAccessToken();
    const refreshToken = newUser.generateRefreshToken();

    newUser.refreshToken = refreshToken;
    await newUser.save();

    return res.status(201).json({
      message: "User created successfully",
      user: {
        _id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        phoneNumber: newUser.phoneNumber,
        vehicleType: newUser.vehicleType,
      },
      tokens: {
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Server error" });
  }
};

const Login = async (req, res) => {
  const { loginname, password } = req.body;

  console.log("Login attempt:", loginname);

  if (!loginname || !password || loginname.trim() === "" || password.trim() === "") {
    return res.status(400).json({ message: "Please provide username/email and password" });
  }

  try {
    const user = await User.findOne({
      $or: [{ username: loginname }, { email: loginname }],
    });

    if (!user) {
      return res.status(404).json({ message: "User not found with given credentials" });
    }

    const passwordCorrect = await user.isPasswordCorrect(password);
    if (!passwordCorrect) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    const { accessToken, refreshToken } = await generateBothToken(user._id);

    user.refreshToken = refreshToken;
    await user.save();

    const loggedInUser = await User.findById(user._id).select("-password -refreshToken");

    return res.status(200).json({
      message: "Logged in successfully",
      accessToken,
      refreshToken,
      user: loggedInUser,
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const refreshAccessToken = async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ message: "Refresh token required" });
  }

  try {
    const payload = verifyToken(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    if (!payload) {
      return res.status(401).json({ message: "Invalid or expired refresh token" });
    }

    const user = await User.findById(payload._id);
    if (!user || user.refreshToken !== refreshToken) {
      return res.status(401).json({ message: "Refresh token revoked or user not found" });
    }

    const newAccessToken = user.generateAccessToken();

    return res.status(200).json({
      message: "Token refreshed successfully",
      accessToken: newAccessToken,
    });
  } catch (error) {
    console.error("refreshAccessToken error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const getuserprofile = async (req, res) => {
  const { username } = req.query;

  console.log("Fetching profile for:", username);

  try {
    if (!username || username.trim() === "") {
      return res.status(400).json({ message: "Username is required" });
    }

    const user = await User.findOne({ username }).select(
      "-password -refreshToken"
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      message: "User profile fetched successfully",
      user,
    });
  } catch (error) {
    console.error("getuserprofile error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const getCurrentUserProfile = async (req, res) => {
  console.log("getCurrentUserProfile called");

  try {
    const authHeader = req.headers?.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ message: "Authorization header missing or malformed" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token missing" });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch (err) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const userId = payload?._id;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user identifier" });
    }

    const user = await User.findById(userId).select("-password -refreshToken");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      message: "User profile fetched successfully",
      user,
    });
  } catch (error) {
    console.error("getCurrentUserProfile error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const updateProfile = async (req, res) => {
  try {
    const authHeader = req.headers?.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];
    let payload;
    try {
      payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const userId = payload?._id;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user identifier" });
    }

    const allowedUpdates = ["username", "phoneNumber", "vehicleType"];
    const updates = {};
    for (const key of allowedUpdates) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No valid fields to update" });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: updates },
      { new: true, runValidators: true }
    ).select("-password -refreshToken");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      message: "Profile updated successfully",
      user,
    });
  } catch (error) {
    console.error("updateProfile error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const deleteAccount = async (req, res) => {
  try {
    const authHeader = req.headers?.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];
    let payload;
    try {
      payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const userId = payload?._id;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user identifier" });
    }

    await User.findByIdAndDelete(userId);

    return res.status(200).json({ message: "Account deleted successfully" });
  } catch (error) {
    console.error("deleteAccount error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const logout = async (req, res) => {
  try {
    const authHeader = req.headers?.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(400).json({ message: "Authorization header missing or malformed" });
    }

    const token = authHeader.split(" ")[1];

    let payload;
    try {
      payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch (err) {
      return res.status(200).json({ message: "Logged out successfully" });
    }

    const userId = payload?._id;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user identifier" });
    }

    await User.findByIdAndUpdate(userId, { $unset: { refreshToken: "" } });

    res.clearCookie("accessToken");
    res.clearCookie("refreshToken");

    return res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};


export {register, Login, getuserprofile, logout, getCurrentUserProfile, refreshAccessToken, updateProfile, deleteAccount, verifyJWT};
