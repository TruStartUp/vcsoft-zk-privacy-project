import { expect } from "chai";
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* Measures what the delivery record calls the dominant criterion: what it costs to
   verify one proof on chain. Both verifiers are the ones snarkjs generated from the
   very same circuit, and the proofs are real. */

const calldata = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/proofs.json"), "utf8"),
);

describe("Comparación de esquemas de prueba", () => {
  it("verifica una prueba Groth16 y mide su costo", async () => {
    const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
    const [a, b, c, signals] = calldata.groth16;

    expect(await verifier.verifyProof(a, b, c, signals)).to.equal(true);

    const gas = await verifier.verifyProof.estimateGas(a, b, c, signals);
    const deploy = (await verifier.deploymentTransaction()!.wait())!.gasUsed;
    console.log(`      groth16 · verificar ${gas} gas · desplegar ${deploy} gas`);
  });

  it("verifica una prueba PLONK y mide su costo", async () => {
    const verifier = await (await ethers.getContractFactory("PlonkVerifier")).deploy();
    const [proof, signals] = calldata.plonk;

    expect(await verifier.verifyProof(proof, signals)).to.equal(true);

    const gas = await verifier.verifyProof.estimateGas(proof, signals);
    const deploy = (await verifier.deploymentTransaction()!.wait())!.gasUsed;
    console.log(`      plonk   · verificar ${gas} gas · desplegar ${deploy} gas`);
  });

  it("rechaza una prueba manipulada", async () => {
    const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
    const [a, b, c, signals] = calldata.groth16;
    const tampered = [...signals];
    tampered[2] = "0x0000000000000000000000000000000000000000000000000000000000000063";

    expect(await verifier.verifyProof(a, b, c, tampered)).to.equal(false);
  });
});
