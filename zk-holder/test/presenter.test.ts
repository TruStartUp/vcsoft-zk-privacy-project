import { describe, expect, it } from "vitest";
import { ContractFunctionRevertedError, encodeErrorResult, parseAbi } from "viem";

import { complianceAttestorAbi } from "../src/chain.js";
import { revertName } from "../src/presenter.js";

const wrapped = (abi: readonly unknown[], data: `0x${string}`) =>
  new ContractFunctionRevertedError({ abi: abi as never, data, functionName: "f" });

describe("reading a revert", () => {
  it("names a custom error of the attestor with its arguments", () => {
    const data = encodeErrorResult({ abi: complianceAttestorAbi, errorName: "AttestationWouldShorten", args: [200n, 100n] });
    expect(revertName(wrapped(complianceAttestorAbi, data))).toEqual({ name: "AttestationWouldShorten", args: [200n, 100n] });
  });

  it("returns the reason string of a require", () => {
    const abi = parseAbi(["error Error(string)"]);
    const data = encodeErrorResult({ abi, errorName: "Error", args: ["Transfer not possible"] });
    expect(revertName(wrapped([], data))?.name).toBe("Transfer not possible");
  });

  it("is null for something that is not a revert", () => {
    expect(revertName(new Error("network down"))).toBeNull();
  });
});
