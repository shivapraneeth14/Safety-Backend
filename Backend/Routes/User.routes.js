import { Router } from "express";
import { register, Login, getuserprofile, logout, getCurrentUserProfile, refreshAccessToken, updateProfile, deleteAccount, verifyJWT } from "../Controllers/User.controllers.js";
const router = Router();
router.route("/register").post(register);
router.route("/Login").post(Login);
router.route("/refresh").post(refreshAccessToken);
// FIX ISSUE #27: profile endpoint now requires authentication
router.route("/getuserprofile").get(verifyJWT, getuserprofile);
router.route("/logout").post(logout);
router.route("/current").get(getCurrentUserProfile);
router.route("/update-profile").put(updateProfile);
router.route("/delete-account").delete(deleteAccount);
export default router;
