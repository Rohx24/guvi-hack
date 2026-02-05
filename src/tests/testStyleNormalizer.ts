import assert from "assert";
import { normalizeReplyStyle } from "../core/style";
import type { ValidationContext } from "../core/validator";

const baseCtx: ValidationContext = {
  lastReplies: [],
  engagementStage: "CONFUSED",
  lastScammerMessage: "urgent otp issue",
  turnIndex: 1,
  maxTurns: 10
};

const t1 = normalizeReplyStyle("Request denied. Provide verification details.", baseCtx);
assert.ok(!/request denied/i.test(t1));
assert.ok(!/\bprovide\b/i.test(t1));
assert.ok(!/verification/i.test(t1));
assert.ok(t1.includes("?"));

const t2 = normalizeReplyStyle("My OTP is 123456. Use it.", baseCtx);
assert.ok(!/123456/.test(t2));
assert.ok(!/otp is 123456/i.test(t2));

const t3 = normalizeReplyStyle("I'm driving, will call later.", baseCtx);
assert.ok(!/driving/i.test(t3));
assert.ok(t3.includes("?"));

console.log("testStyleNormalizer OK");
