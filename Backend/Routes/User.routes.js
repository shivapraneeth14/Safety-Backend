import { Router } from "express";
import { register, Login } from "../Controllers/User.controllers.js";
const router = Router();
router.route("/register").post(register);
router.route("/Login").post(Login);
export default router;