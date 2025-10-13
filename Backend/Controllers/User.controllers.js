import bcrypt from "bcrypt"
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import User from "../Models/User.Model.js";


const saltroundes = 10;
async function generatebothtoken(userid) {
    try {
        const user = await User.findById(userid);
        if (!user) {
            console.error(`generatebothtoken: User not found for id ${userid}`);
            throw new Error("User not found");
        }

        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();

        console.log(`generatebothtoken: Tokens generated for user ${userid}`);
        return { accessToken, refreshToken };
    } catch (error) {
        console.error("generatebothtoken error:", error);
        throw new Error("Error generating tokens");
    }
}
const register = async (req, res) => {
  const { username, email, password, phoneNumber } = req.body;

  console.log("backend", req.body);

  try {
    // Validate required fields
    if (!username || !email || !password) {
      return res.status(400).json({ message: "Please provide username, email, and password" });
    }

    // Check for existing user
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists with this email" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      phoneNumber: phoneNumber || undefined,
    });

    // Generate tokens
    const accessToken = newUser.generateAccessToken();
    const refreshToken = newUser.generateRefreshToken();

    // Save refresh token in DB
    newUser.refreshToken = refreshToken;
    await newUser.save();

    return res.status(201).json({
      message: "User created successfully",
      user: {
        _id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        phoneNumber: newUser.phoneNumber,
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
  const { loginname, password } = req.body; // loginname = username or email

  console.log("Login attempt:", loginname);

  // Validate input
  if (!loginname || !password || loginname.trim() === "" || password.trim() === "") {
    return res.status(400).json({ message: "Please provide username/email and password" });
  }

  try {
    // Find user by username OR email
    const user = await User.findOne({
      $or: [{ username: loginname }, { email: loginname }],
    });

    if (!user) {
      return res.status(404).json({ message: "User not found with given credentials" });
    }

    // Verify password
    const passwordCorrect = await user.isPasswordCorrect(password);
    if (!passwordCorrect) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    // Generate tokens
    const { accessToken, refreshToken } = await generatebothtoken(user._id);


    // Save refresh token in DB
    user.refreshToken = refreshToken;
    await user.save();

    // Return user info and tokens
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
    // 1️⃣ Check Authorization header
    const authHeader = req.headers?.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ message: "Authorization header missing or malformed" });
    }

    // 2️⃣ Extract token
    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "Token missing" });
    }

    // 3️⃣ Verify token
    let payload;
    try {
      payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch (err) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    // 4️⃣ Validate user ID in token
    const userId = payload?._id;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user identifier" });
    }

    // 5️⃣ Fetch user data (exclude password & refreshToken)
    const user = await User.findById(userId).select("-password -refreshToken");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // 6️⃣ Return user data
    return res.status(200).json({
      message: "User profile fetched successfully",
      user,
    });
  } catch (error) {
    console.error("getCurrentUserProfile error:", error);
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
      // Even if token invalid, still return success
      return res.status(200).json({ message: "Logged out successfully" });
    }

    const userId = payload?._id;
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid user identifier" });
    }

    // Remove refresh token from DB
    await User.findByIdAndUpdate(userId, { $unset: { refreshToken: "" } });

    // Clear cookies (if used)
    res.clearCookie("accessToken");
    res.clearCookie("refreshToken");

    return res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};


export{register,Login,getuserprofile,logout,getCurrentUserProfile};