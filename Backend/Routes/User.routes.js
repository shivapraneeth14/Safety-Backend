import { Router } from "express";
import { register, Login,getuserprofile,logout,getCurrentUserProfile } from "../Controllers/User.controllers.js";
const router = Router();
router.route("/register").post(register);
router.route("/Login").post(Login);
router.route("/getuserprofile").get(getuserprofile);
router.route("/logout").post(logout);
router.route("/current").get(getCurrentUserProfile);
export default router;