import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  ASSET_A,
  CURRENT_EPOCH_END,
  NOW,
  PAST_EPOCH_END,
  SCALAR_FIELD,
  attestAt,
  attestForAt,
  deployComplianceStack,
  fixture,
  plonkProofs,
  proofBody,
  proofs,
} from "./helpers";

/* The delivery record promises that "the architecture isolates the verifier behind a
   well defined boundary, so that the scheme can be replaced without redesigning the
   solution". This file is what turns that sentence into something a reader can check.

   The whole attestation is walked twice over the same witness -- once with the Groth16
   adapter mounted and once with the PLONK one -- and nothing about `ComplianceAttestor`
   changes between the two runs: not its address, not its roles, not its spent
   nullifiers, not a line of its code. What changes is one storage slot. */

const ALICE_NULLIFIER = BigInt(proofs.aliceCurrent.signals[4]);
const COUNTRY_ROOT_B = BigInt(fixture.roots.countryB);

const shift = (signals: string[], index: number, by: bigint) => {
  const copy = [...signals];
  copy[index] = "0x" + (BigInt(signals[index]) + by).toString(16).padStart(64, "0");
  return copy;
};

describe("La frontera del verificador", () => {
  describe("el atestador no nombra ningún esquema", () => {
    it("monta un verificador que declara el suyo, y no lo consulta para nada más", async () => {
      const { attestor, groth16Adapter, plonkAdapter } = await loadFixture(deployComplianceStack);

      expect(await attestor.verifier()).to.equal(await groth16Adapter.getAddress());
      expect(await groth16Adapter.scheme()).to.equal("groth16");
      expect(await plonkAdapter.scheme()).to.equal("plonk");
      expect(await groth16Adapter.proofLength()).to.equal(8 * 32);
      expect(await plonkAdapter.proofLength()).to.equal(24 * 32);
    });

    it("la misma afirmación pública viaja en dos cuerpos de prueba distintos", async () => {
      expect(plonkProofs.aliceCurrent.signals).to.deep.equal(proofs.aliceCurrent.signals);
      expect(proofBody(proofs.aliceCurrent)).to.not.equal(proofBody(plonkProofs.aliceCurrent));
      expect(ethers.dataLength(proofBody(proofs.aliceCurrent))).to.equal(8 * 32);
      expect(ethers.dataLength(proofBody(plonkProofs.aliceCurrent))).to.equal(24 * 32);
    });

    it("un cuerpo de prueba de la longitud equivocada es sólo una prueba inválida", async () => {
      const { attestor, alice, groth16Adapter } = await loadFixture(deployComplianceStack);
      const plonkBody = proofBody(plonkProofs.aliceCurrent);

      expect(await groth16Adapter.verifyCompliance(plonkBody, proofs.aliceCurrent.signals)).to.equal(false);
      await expect(
        attestor.connect(alice).attest(plonkBody, proofs.aliceCurrent.signals),
      ).to.be.revertedWithCustomError(attestor, "InvalidProof");
    });

    it("cada adaptador acepta lo que su verificador acepta, y sólo eso", async () => {
      const { groth16Adapter, plonkAdapter, verifier, plonkVerifier } = await loadFixture(deployComplianceStack);
      const { a, b, c, signals } = proofs.aliceCurrent;

      expect(await verifier.verifyProof(a as any, b as any, c as any, signals as any)).to.equal(true);
      expect(await groth16Adapter.verifyCompliance(proofBody(proofs.aliceCurrent), signals)).to.equal(true);

      expect(await plonkVerifier.verifyProof(plonkProofs.aliceCurrent.proof as any, signals as any)).to.equal(true);
      expect(await plonkAdapter.verifyCompliance(proofBody(plonkProofs.aliceCurrent), signals)).to.equal(true);

      expect(await plonkAdapter.verifyCompliance(proofBody(proofs.aliceCurrent), signals)).to.equal(false);
      expect(await groth16Adapter.verifyCompliance(proofBody(plonkProofs.aliceCurrent), signals)).to.equal(false);
    });
  });

  describe("sustituir el esquema sin redesplegar el atestador", () => {
    it("sólo el administrador lo sustituye, y nunca por la dirección cero", async () => {
      const { attestor, admin, outsider, plonkAdapter } = await loadFixture(deployComplianceStack);

      await expect(attestor.connect(outsider).setVerifier(await plonkAdapter.getAddress())).to.be.revertedWith(
        /AccessControl: account .* is missing role/,
      );
      await expect(attestor.connect(admin).setVerifier(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        attestor,
        "ZeroAddress",
      );
    });

    it("deja constancia del esquema que entra y del verificador que sale", async () => {
      const { attestor, admin, groth16Adapter, plonkAdapter } = await loadFixture(deployComplianceStack);

      await expect(attestor.connect(admin).setVerifier(await plonkAdapter.getAddress()))
        .to.emit(attestor, "VerifierUpdated")
        .withArgs(await groth16Adapter.getAddress(), await plonkAdapter.getAddress(), "plonk");

      expect(await attestor.verifier()).to.equal(await plonkAdapter.getAddress());
    });

    /// The evidence the delivery record's claim stands on: the same attestation, end to
    /// end, over the same witness, decided by a different proving scheme.
    it("recorre la misma atestación completa con el adaptador de PLONK", async () => {
      const { attestor, admin, alice, plonkAdapter } = await loadFixture(deployComplianceStack);
      await attestor.connect(admin).setVerifier(await plonkAdapter.getAddress());

      await expect(attestAt(attestor, alice, plonkProofs.aliceCurrent))
        .to.emit(attestor, "ComplianceAttested")
        .withArgs(ASSET_A, alice.address, ALICE_NULLIFIER, NOW, CURRENT_EPOCH_END);

      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
      expect(await attestor.isNullifierSpent(ALICE_NULLIFIER)).to.equal(true);
      expect(await attestor.attestationExpiry(ASSET_A, alice.address)).to.equal(CURRENT_EPOCH_END);

      const attestation = await attestor.attestationOf(ASSET_A, alice.address);
      expect(attestation.issuedAt).to.equal(NOW);
      expect(attestation.nullifier).to.equal(ALICE_NULLIFIER);
    });

    it("la plataforma presenta la prueba del titular bajo uno y otro esquema", async () => {
      for (const [scheme, proof] of [
        ["groth16", proofs.aliceCurrent],
        ["plonk", plonkProofs.aliceCurrent],
      ] as const) {
        const { attestor, admin, alice, bob, platform, groth16Adapter, plonkAdapter } =
          await loadFixture(deployComplianceStack);
        const adapter = scheme === "plonk" ? plonkAdapter : groth16Adapter;
        if (scheme === "plonk") await attestor.connect(admin).setVerifier(await adapter.getAddress());
        expect(await (await ethers.getContractAt("IProofVerifier", await attestor.verifier())).scheme()).to.equal(scheme);

        await expect(attestForAt(attestor, platform, bob.address, proof), scheme).to.be.revertedWithCustomError(
          attestor,
          "AnchorMismatch",
        );
        await expect(attestForAt(attestor, platform, alice.address, proof, NOW + 1), scheme)
          .to.emit(attestor, "ComplianceAttested")
          .withArgs(ASSET_A, alice.address, ALICE_NULLIFIER, NOW + 1, CURRENT_EPOCH_END);
        expect(await attestor.isAttested(ASSET_A, platform.address), scheme).to.equal(false);
        await expect(attestAt(attestor, alice, proof, NOW + 2), scheme)
          .to.be.revertedWithCustomError(attestor, "NullifierAlreadySpent")
          .withArgs(ALICE_NULLIFIER);
      }
    });

    it("bajo PLONK el atestador sigue imponiendo las mismas precondiciones", async () => {
      const { attestor, admin, alice, outsider, plonkAdapter } = await loadFixture(deployComplianceStack);
      await attestor.connect(admin).setVerifier(await plonkAdapter.getAddress());

      await expect(attestAt(attestor, alice, plonkProofs.alicePastPeriod))
        .to.be.revertedWithCustomError(attestor, "EpochEndNotCurrent")
        .withArgs(PAST_EPOCH_END, CURRENT_EPOCH_END);

      await expect(attestAt(attestor, outsider, plonkProofs.aliceCurrent, NOW + 1)).to.be.revertedWithCustomError(
        attestor,
        "AnchorMismatch",
      );

      await expect(attestAt(attestor, alice, plonkProofs.aliceForeignCountryRoot, NOW + 2))
        .to.be.revertedWithCustomError(attestor, "CountryRootNotValid")
        .withArgs(ASSET_A, COUNTRY_ROOT_B);

      const outOfField = shift(plonkProofs.aliceCurrent.signals, 4, SCALAR_FIELD);
      await expect(attestAt(attestor, alice, plonkProofs.aliceCurrent, NOW + 3, outOfField))
        .to.be.revertedWithCustomError(attestor, "PublicSignalOutOfField")
        .withArgs(4, ALICE_NULLIFIER + SCALAR_FIELD);

      await attestAt(attestor, alice, plonkProofs.aliceCurrent, NOW + 4);
      await expect(attestAt(attestor, alice, plonkProofs.aliceCurrent, NOW + 5))
        .to.be.revertedWithCustomError(attestor, "NullifierAlreadySpent")
        .withArgs(ALICE_NULLIFIER);
    });

    it("una prueba del esquema que salió deja de valer en el instante de la rotación", async () => {
      const { attestor, admin, alice, plonkAdapter, groth16Adapter } = await loadFixture(deployComplianceStack);

      await attestor.connect(admin).setVerifier(await plonkAdapter.getAddress());
      await expect(attestAt(attestor, alice, proofs.aliceCurrent)).to.be.revertedWithCustomError(
        attestor,
        "InvalidProof",
      );

      await attestor.connect(admin).setVerifier(await groth16Adapter.getAddress());
      await expect(attestAt(attestor, alice, plonkProofs.aliceCurrent, NOW + 2)).to.be.revertedWithCustomError(
        attestor,
        "InvalidProof",
      );
      await expect(attestAt(attestor, alice, proofs.aliceCurrent, NOW + 3)).to.emit(attestor, "ComplianceAttested");
    });

    it("lo ya concedido y lo ya gastado sobreviven a la rotación", async () => {
      const { attestor, admin, alice, bob, plonkAdapter } = await loadFixture(deployComplianceStack);

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await attestor.connect(admin).setVerifier(await plonkAdapter.getAddress());

      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
      expect(await attestor.isNullifierSpent(ALICE_NULLIFIER)).to.equal(true);

      // The same statement re-proved under the new scheme carries the same nullifier,
      // so rotating cannot be used to spend one twice.
      await expect(attestAt(attestor, alice, plonkProofs.aliceCurrent, NOW + 2))
        .to.be.revertedWithCustomError(attestor, "NullifierAlreadySpent")
        .withArgs(ALICE_NULLIFIER);

      await expect(attestAt(attestor, bob, plonkProofs.bobCurrent, NOW + 3)).to.emit(attestor, "ComplianceAttested");
    });
  });

  /// snarkjs runs `checkField` over the six public signals in the Groth16 verifier it
  /// generates, and does not in the PLONK one: there they go straight into the
  /// transcript and into `calculatePI`, where `mulmod` reduces them. A prover that
  /// writes its transcript over the non-canonical encoding therefore gets a valid proof
  /// for `s + r`, which the attestor would record as a nullifier distinct from `s`.
  ///
  /// The check cannot live only in whichever verifier happens to be mounted, so it lives
  /// in the PLONK adapter as well as in the attestor. These tests separate the two
  /// sources by putting a verifier that accepts everything behind each adapter and
  /// asking what is left.
  describe("la señal fuera del campo, esquema a esquema", () => {
    it("en Groth16 la rechaza el verificador generado, no el adaptador", async () => {
      const permissive = await (await ethers.getContractFactory("AlwaysAcceptingVerifier")).deploy();
      const adapter = await (await ethers.getContractFactory("Groth16VerifierAdapter")).deploy(
        await permissive.getAddress(),
      );
      const body = proofBody(proofs.aliceCurrent);
      const shifted = shift(proofs.aliceCurrent.signals, 4, SCALAR_FIELD);

      expect(await adapter.verifyCompliance(body, shifted)).to.equal(true);

      const generated = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
      const real = await (await ethers.getContractFactory("Groth16VerifierAdapter")).deploy(
        await generated.getAddress(),
      );
      expect(await real.verifyCompliance(body, shifted)).to.equal(false);
    });

    it("en PLONK la rechaza el adaptador, porque su verificador no la mira", async () => {
      const permissive = await (await ethers.getContractFactory("AlwaysAcceptingVerifier")).deploy();
      const adapter = await (await ethers.getContractFactory("PlonkVerifierAdapter")).deploy(
        await permissive.getAddress(),
      );
      const body = proofBody(plonkProofs.aliceCurrent);

      expect(await adapter.verifyCompliance(body, plonkProofs.aliceCurrent.signals)).to.equal(true);

      for (let index = 0; index < 6; index++) {
        const shifted = shift(plonkProofs.aliceCurrent.signals, index, SCALAR_FIELD);
        expect(await adapter.verifyCompliance(body, shifted), `señal ${index}`).to.equal(false);
      }
    });

    it("el atestador la rechaza igual, monte el esquema que monte", async () => {
      const { attestor, admin, alice, plonkAdapter } = await loadFixture(deployComplianceStack);
      const shifted = shift(proofs.aliceCurrent.signals, 0, SCALAR_FIELD);

      await expect(
        attestAt(attestor, alice, proofs.aliceCurrent, NOW, shifted),
      ).to.be.revertedWithCustomError(attestor, "PublicSignalOutOfField");

      await attestor.connect(admin).setVerifier(await plonkAdapter.getAddress());
      await expect(
        attestAt(attestor, alice, plonkProofs.aliceCurrent, NOW + 2, shifted),
      ).to.be.revertedWithCustomError(attestor, "PublicSignalOutOfField");
    });
  });

  describe("lo que cuesta cada esquema donde importa", () => {
    it("mide la atestación completa con uno y con otro", async () => {
      const groth16 = await loadFixture(deployComplianceStack);
      const groth16Receipt = await (await attestAt(groth16.attestor, groth16.alice, proofs.aliceCurrent)).wait();

      const plonk = await loadFixture(deployComplianceStack);
      await plonk.attestor.connect(plonk.admin).setVerifier(await plonk.plonkAdapter.getAddress());
      const plonkReceipt = await (await attestAt(plonk.attestor, plonk.alice, plonkProofs.aliceCurrent, NOW + 1)).wait();

      console.log(`      atestación · groth16 ${groth16Receipt!.gasUsed} gas · plonk ${plonkReceipt!.gasUsed} gas`);
      expect(groth16Receipt!.gasUsed).to.be.lessThan(plonkReceipt!.gasUsed);

      const groth16For = await loadFixture(deployComplianceStack);
      const groth16ForReceipt = await (
        await attestForAt(groth16For.attestor, groth16For.platform, groth16For.alice.address, proofs.aliceCurrent)
      ).wait();

      const plonkFor = await loadFixture(deployComplianceStack);
      await plonkFor.attestor.connect(plonkFor.admin).setVerifier(await plonkFor.plonkAdapter.getAddress());
      const plonkForReceipt = await (
        await attestForAt(plonkFor.attestor, plonkFor.platform, plonkFor.alice.address, plonkProofs.aliceCurrent, NOW + 1)
      ).wait();

      console.log(
        `      atestación presentada por la plataforma · groth16 ${groth16ForReceipt!.gasUsed} gas · plonk ${plonkForReceipt!.gasUsed} gas`,
      );
      expect(groth16ForReceipt!.gasUsed).to.be.lessThan(plonkForReceipt!.gasUsed);
    });
  });
});
