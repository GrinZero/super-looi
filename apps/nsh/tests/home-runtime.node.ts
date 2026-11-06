import { test } from "node:test";
import { verifyHomeRuntime } from "./home-runtime-cases.js";

test("NSH home fixtures preserve safe readback, configuration generations and no replay", verifyHomeRuntime);
