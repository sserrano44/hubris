import assert from "node:assert/strict";
import test from "node:test";
import { hashPair, poseidon2Permute3 } from "./hash";
test("poseidon2 permutation regression vector is stable", () => {
    const output = poseidon2Permute3([0n, 1n, 2n]);
    assert.deepEqual(output, [
        14200285801827375193874737842270308572374888567220732262914905153022814263803n,
        5316240577722824134207302462015176374180934016570634976784285558543592517839n,
        16821833312502412175991506692171278649935476954955489266354145709596147613486n
    ]);
});
test("hashPair returns lane 0 of Poseidon2([left,right,0])", () => {
    const left = 123456789n;
    const right = 987654321n;
    const [expected] = poseidon2Permute3([left, right, 0n]);
    const result = hashPair(left, right);
    assert.equal(result, expected);
});
//# sourceMappingURL=hash.test.js.map