import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  ASSET_A,
  ASSET_B,
  CURRENT_EPOCH_END,
  EPOCH_LENGTH,
  FAR_FUTURE_EPOCH_END,
  MISALIGNED_EPOCH_END,
  NEXT_EPOCH_END,
  NOW,
  PAST_EPOCH_END,
  ROOT_SUPERSEDED_AT,
  SCALAR_FIELD,
  attestAt,
  attestForAt,
  deployComplianceStack,
  fixture,
  proofs,
} from "./helpers";

const CURRENT_ROOT = BigInt(fixture.roots.credentialCurrent);
const INITIAL_ROOT = BigInt(fixture.roots.credentialInitial);
const COUNTRY_ROOT_B = BigInt(fixture.roots.countryB);

const ALICE_NULLIFIER = BigInt(proofs.aliceCurrent.signals[4]);
const BOB_NULLIFIER = BigInt(proofs.bobCurrent.signals[4]);
const ALICE_ANCHOR = BigInt(proofs.aliceCurrent.signals[5]);

const shift = (signals: string[], index: number, by: bigint) => {
  const copy = [...signals];
  copy[index] = "0x" + (BigInt(signals[index]) + by).toString(16).padStart(64, "0");
  return copy;
};

describe("ComplianceAttestor", () => {
  describe("configuración", () => {
    it("se despliega con la longitud de época documentada por defecto", async () => {
      const { attestor } = await loadFixture(deployComplianceStack);

      expect(await attestor.DEFAULT_EPOCH_LENGTH()).to.equal(EPOCH_LENGTH);
      expect(await attestor.epochLength()).to.equal(EPOCH_LENGTH);
    });

    it("publica el fin del periodo corriente y el anclaje que cada titular debe llevar", async () => {
      const { attestor, alice, bob } = await loadFixture(deployComplianceStack);

      await time.increaseTo(NOW);
      expect(await attestor.currentEpochEnd()).to.equal(CURRENT_EPOCH_END);
      expect(await attestor.anchorFor(alice.address)).to.equal(ALICE_ANCHOR);
      expect(await attestor.anchorFor(bob.address)).to.not.equal(ALICE_ANCHOR);
    });
  });

  describe("camino feliz", () => {
    it("atestigua al remitente hasta el fin del periodo, gasta el nulificador y deja constancia", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      const attested = await attestAt(attestor, alice, proofs.aliceCurrent);
      await expect(attested)
        .to.emit(attestor, "ComplianceAttested")
        .withArgs(ASSET_A, alice.address, ALICE_NULLIFIER, NOW, CURRENT_EPOCH_END);
      console.log(`      atestación completa · ${(await attested.wait()).gasUsed} gas`);

      expect(await attestor.isNullifierSpent(ALICE_NULLIFIER)).to.equal(true);
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
      expect(await attestor.attestationExpiry(ASSET_A, alice.address)).to.equal(CURRENT_EPOCH_END);

      const attestation = await attestor.attestationOf(ASSET_A, alice.address);
      expect(attestation.issuedAt).to.equal(NOW);
      expect(attestation.nullifier).to.equal(ALICE_NULLIFIER);
    });

    it("dos inversores distintos sobre el mismo activo se atestiguan por separado", async () => {
      const { attestor, alice, bob } = await loadFixture(deployComplianceStack);

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await attestAt(attestor, bob, proofs.bobCurrent, NOW + 1);

      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
      expect(await attestor.isAttested(ASSET_A, bob.address)).to.equal(true);
      expect(BOB_NULLIFIER).to.not.equal(ALICE_NULLIFIER);
    });

    it("la misma credencial en otro activo produce otro nulificador y otra atestación", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await attestAt(attestor, alice, proofs.aliceOnAssetB, NOW + 1);

      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
      expect(await attestor.isAttested(ASSET_B, alice.address)).to.equal(true);
      expect(BigInt(proofs.aliceOnAssetB.signals[4])).to.not.equal(ALICE_NULLIFIER);
    });

    it("la atestación es un permiso vigente, no un vale: dura todo el periodo", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      await attestAt(attestor, alice, proofs.aliceCurrent);
      for (const instant of [NOW + 1, NOW + EPOCH_LENGTH / 2, CURRENT_EPOCH_END - 1]) {
        await time.increaseTo(instant);
        expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
      }

      await time.increaseTo(CURRENT_EPOCH_END);
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(false);
    });
  });

  describe("precondición: el periodo es el corriente o el siguiente", () => {
    it("rechaza un periodo ya cerrado", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      await expect(attestAt(attestor, alice, proofs.alicePastPeriod))
        .to.be.revertedWithCustomError(attestor, "EpochEndNotCurrent")
        .withArgs(PAST_EPOCH_END, CURRENT_EPOCH_END);
    });

    it("rechaza un periodo demasiado lejano", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      await expect(attestAt(attestor, alice, proofs.aliceFarFuturePeriod))
        .to.be.revertedWithCustomError(attestor, "EpochEndNotCurrent")
        .withArgs(FAR_FUTURE_EPOCH_END, CURRENT_EPOCH_END);
    });

    it("rechaza un fin de periodo que no cae en la retícula de la época", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      await expect(attestAt(attestor, alice, proofs.aliceMisalignedPeriod))
        .to.be.revertedWithCustomError(attestor, "EpochEndNotCurrent")
        .withArgs(MISALIGNED_EPOCH_END, CURRENT_EPOCH_END);
    });

    it("renueva por adelantado sobre la misma credencial, sin ventana muerta", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await expect(attestAt(attestor, alice, proofs.aliceNextPeriod, NOW + 1))
        .to.emit(attestor, "ComplianceAttested")
        .withArgs(ASSET_A, alice.address, BigInt(proofs.aliceNextPeriod.signals[4]), NOW + 1, NEXT_EPOCH_END);

      await time.increaseTo(CURRENT_EPOCH_END);
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
      await time.increaseTo(NEXT_EPOCH_END);
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(false);
    });

    it("el periodo siguiente pasa a ser el corriente cuando llega su turno", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      await time.increaseTo(CURRENT_EPOCH_END);
      expect(await attestor.currentEpochEnd()).to.equal(NEXT_EPOCH_END);
      await expect(attestAt(attestor, alice, proofs.aliceNextPeriod, CURRENT_EPOCH_END + 1)).to.emit(
        attestor,
        "ComplianceAttested",
      );
      await expect(attestAt(attestor, alice, proofs.aliceCurrent, CURRENT_EPOCH_END + 2))
        .to.be.revertedWithCustomError(attestor, "EpochEndNotCurrent")
        .withArgs(CURRENT_EPOCH_END, NEXT_EPOCH_END);
    });
  });

  describe("precondición: la prueba sólo atestigua al titular que nombra su anclaje", () => {
    it("rechaza a un tercero que copia la prueba del mempool", async () => {
      const { attestor, bob, outsider } = await loadFixture(deployComplianceStack);

      await expect(attestAt(attestor, outsider, proofs.aliceCurrent))
        .to.be.revertedWithCustomError(attestor, "AnchorMismatch")
        .withArgs(ALICE_ANCHOR, await attestor.anchorFor(outsider.address));
      await expect(attestAt(attestor, bob, proofs.aliceCurrent, NOW + 1)).to.be.revertedWithCustomError(
        attestor,
        "AnchorMismatch",
      );
    });

    it("adelantarse ya no quema el nulificador de la víctima", async () => {
      const { attestor, alice, outsider } = await loadFixture(deployComplianceStack);

      await expect(attestAt(attestor, outsider, proofs.aliceCurrent)).to.be.revertedWithCustomError(
        attestor,
        "AnchorMismatch",
      );
      expect(await attestor.isNullifierSpent(ALICE_NULLIFIER)).to.equal(false);

      await expect(attestAt(attestor, alice, proofs.aliceCurrent, NOW + 1)).to.emit(attestor, "ComplianceAttested");
    });

    it("rechaza la misma prueba en otro despliegue del atestador", async () => {
      const { attestor, admin, alice, registry, groth16Adapter } = await loadFixture(deployComplianceStack);

      const twin = await (await ethers.getContractFactory("ComplianceAttestor")).deploy(
        admin.address,
        await registry.getAddress(),
        await groth16Adapter.getAddress(),
        EPOCH_LENGTH,
      );

      expect(await twin.anchorFor(alice.address)).to.not.equal(await attestor.anchorFor(alice.address));
      await expect(attestAt(twin, alice, proofs.aliceCurrent))
        .to.be.revertedWithCustomError(twin, "AnchorMismatch")
        .withArgs(ALICE_ANCHOR, await twin.anchorFor(alice.address));
    });

    it("el anclaje está atado dentro de la prueba, no sólo comprobado en el contrato", async () => {
      const { verifier } = await loadFixture(deployComplianceStack);
      const { a, b, c, signals } = proofs.aliceCurrent;

      expect(await verifier.verifyProof(a as any, b as any, c as any, signals as any)).to.equal(true);
      expect(
        await verifier.verifyProof(a as any, b as any, c as any, shift(signals, 5, 1n) as any),
      ).to.equal(false);
    });
  });

  describe("la plataforma presenta la prueba del titular", () => {
    it("otra cuenta la presenta y la atestación queda a nombre del titular", async () => {
      const { attestor, alice, platform } = await loadFixture(deployComplianceStack);
      const aliceNonce = await ethers.provider.getTransactionCount(alice.address);

      const presented = await attestForAt(attestor, platform, alice.address, proofs.aliceCurrent);
      await expect(presented)
        .to.emit(attestor, "ComplianceAttested")
        .withArgs(ASSET_A, alice.address, ALICE_NULLIFIER, NOW, CURRENT_EPOCH_END);
      const receipt = await presented.wait();
      console.log(`      atestación presentada por la plataforma · ${receipt.gasUsed} gas`);

      expect(receipt.from).to.equal(platform.address);
      expect(await ethers.provider.getTransactionCount(alice.address)).to.equal(aliceNonce);
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
      expect(await attestor.isAttested(ASSET_A, platform.address)).to.equal(false);
      expect(await attestor.isNullifierSpent(ALICE_NULLIFIER)).to.equal(true);

      const attestation = await attestor.attestationOf(ASSET_A, alice.address);
      expect(attestation.issuedAt).to.equal(NOW);
      expect(attestation.expiresAt).to.equal(CURRENT_EPOCH_END);
      expect(attestation.nullifier).to.equal(ALICE_NULLIFIER);
    });

    it("la plataforma renueva por adelantado sin que el titular envíe nada", async () => {
      const { attestor, alice, platform } = await loadFixture(deployComplianceStack);

      await attestForAt(attestor, platform, alice.address, proofs.aliceCurrent);
      await expect(attestForAt(attestor, platform, alice.address, proofs.aliceNextPeriod, NOW + 1))
        .to.emit(attestor, "ComplianceAttested")
        .withArgs(ASSET_A, alice.address, BigInt(proofs.aliceNextPeriod.signals[4]), NOW + 1, NEXT_EPOCH_END);

      await time.increaseTo(CURRENT_EPOCH_END);
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
    });

    it("presentada para otro sujeto se rechaza con AnchorMismatch y no gasta nada", async () => {
      const { attestor, bob, platform } = await loadFixture(deployComplianceStack);

      await expect(attestForAt(attestor, platform, bob.address, proofs.aliceCurrent))
        .to.be.revertedWithCustomError(attestor, "AnchorMismatch")
        .withArgs(ALICE_ANCHOR, await attestor.anchorFor(bob.address));
      await expect(attestForAt(attestor, platform, platform.address, proofs.aliceCurrent, NOW + 1))
        .to.be.revertedWithCustomError(attestor, "AnchorMismatch")
        .withArgs(ALICE_ANCHOR, await attestor.anchorFor(platform.address));

      expect(await attestor.isNullifierSpent(ALICE_NULLIFIER)).to.equal(false);
      expect(await attestor.isAttested(ASSET_A, bob.address)).to.equal(false);
    });

    it("quien copia la prueba del mempool sólo puede atestiguar al mismo titular", async () => {
      const { attestor, alice, outsider, platform } = await loadFixture(deployComplianceStack);

      await expect(attestForAt(attestor, outsider, outsider.address, proofs.aliceCurrent))
        .to.be.revertedWithCustomError(attestor, "AnchorMismatch")
        .withArgs(ALICE_ANCHOR, await attestor.anchorFor(outsider.address));

      await expect(attestForAt(attestor, outsider, alice.address, proofs.aliceCurrent, NOW + 1))
        .to.emit(attestor, "ComplianceAttested")
        .withArgs(ASSET_A, alice.address, ALICE_NULLIFIER, NOW + 1, CURRENT_EPOCH_END);
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
      expect(await attestor.isAttested(ASSET_A, outsider.address)).to.equal(false);

      await expect(attestForAt(attestor, platform, alice.address, proofs.aliceCurrent, NOW + 2))
        .to.be.revertedWithCustomError(attestor, "NullifierAlreadySpent")
        .withArgs(ALICE_NULLIFIER);
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
    });

    it("un nulificador gastado por una vía no se reutiliza por la otra", async () => {
      const { attestor, alice, platform } = await loadFixture(deployComplianceStack);

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await expect(attestForAt(attestor, platform, alice.address, proofs.aliceCurrent, NOW + 1))
        .to.be.revertedWithCustomError(attestor, "NullifierAlreadySpent")
        .withArgs(ALICE_NULLIFIER);

      await attestForAt(attestor, platform, alice.address, proofs.aliceOnAssetB, NOW + 2);
      await expect(attestAt(attestor, alice, proofs.aliceOnAssetB, NOW + 3))
        .to.be.revertedWithCustomError(attestor, "NullifierAlreadySpent")
        .withArgs(BigInt(proofs.aliceOnAssetB.signals[4]));
      await expect(attestForAt(attestor, platform, alice.address, proofs.aliceOnAssetB, NOW + 4))
        .to.be.revertedWithCustomError(attestor, "NullifierAlreadySpent");
    });

    it("las dos vías dejan la misma atestación y el mismo evento", async () => {
      const direct = await loadFixture(deployComplianceStack);
      await attestAt(direct.attestor, direct.alice, proofs.aliceCurrent);

      const presented = await loadFixture(deployComplianceStack);
      await expect(attestForAt(presented.attestor, presented.platform, presented.alice.address, proofs.aliceCurrent))
        .to.emit(presented.attestor, "ComplianceAttested")
        .withArgs(ASSET_A, presented.alice.address, ALICE_NULLIFIER, NOW, CURRENT_EPOCH_END);

      expect(await presented.attestor.attestationOf(ASSET_A, presented.alice.address)).to.deep.equal(
        await direct.attestor.attestationOf(ASSET_A, direct.alice.address),
      );
    });

    it("rechaza la dirección cero como sujeto", async () => {
      const { attestor, platform } = await loadFixture(deployComplianceStack);

      await expect(
        attestForAt(attestor, platform, ethers.ZeroAddress, proofs.aliceCurrent),
      ).to.be.revertedWithCustomError(attestor, "ZeroAddress");
    });
  });

  describe("precondición: una atestación viva no se acorta", () => {
    const CURRENT_NULLIFIER = ALICE_NULLIFIER;
    const NEXT_NULLIFIER = BigInt(proofs.aliceNextPeriod.signals[4]);

    it("con la del periodo siguiente dentro, la del corriente revierte sin gastar su nulificador", async () => {
      const { attestor, alice, platform } = await loadFixture(deployComplianceStack);

      await attestForAt(attestor, platform, alice.address, proofs.aliceNextPeriod);
      await expect(attestForAt(attestor, platform, alice.address, proofs.aliceCurrent, NOW + 1))
        .to.be.revertedWithCustomError(attestor, "AttestationWouldShorten")
        .withArgs(NEXT_EPOCH_END, CURRENT_EPOCH_END);
      await expect(attestAt(attestor, alice, proofs.aliceCurrent, NOW + 2))
        .to.be.revertedWithCustomError(attestor, "AttestationWouldShorten")
        .withArgs(NEXT_EPOCH_END, CURRENT_EPOCH_END);

      expect(await attestor.isNullifierSpent(CURRENT_NULLIFIER)).to.equal(false);
      expect(await attestor.attestationExpiry(ASSET_A, alice.address)).to.equal(NEXT_EPOCH_END);
      await time.increaseTo(CURRENT_EPOCH_END);
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
    });

    it("quien reordena desde el mempool las dos pruebas del titular no le quita nada", async () => {
      const { attestor, alice, outsider, platform } = await loadFixture(deployComplianceStack);

      await attestForAt(attestor, outsider, alice.address, proofs.aliceNextPeriod);
      await expect(
        attestForAt(attestor, platform, alice.address, proofs.aliceCurrent, NOW + 1),
      ).to.be.revertedWithCustomError(attestor, "AttestationWouldShorten");
      await expect(attestForAt(attestor, platform, alice.address, proofs.aliceNextPeriod, NOW + 2))
        .to.be.revertedWithCustomError(attestor, "NullifierAlreadySpent")
        .withArgs(NEXT_NULLIFIER);

      const attestation = await attestor.attestationOf(ASSET_A, alice.address);
      expect(attestation.expiresAt).to.equal(NEXT_EPOCH_END);
      expect(attestation.nullifier).to.equal(NEXT_NULLIFIER);
      expect(await attestor.isNullifierSpent(CURRENT_NULLIFIER)).to.equal(false);
    });

    it("una revocación borra el registro, y la del corriente vuelve a admitirse", async () => {
      const { attestor, admin, alice, platform } = await loadFixture(deployComplianceStack);

      await attestForAt(attestor, platform, alice.address, proofs.aliceNextPeriod);
      await attestor.connect(admin).revokeAttestation(ASSET_A, alice.address);

      await expect(attestForAt(attestor, platform, alice.address, proofs.aliceCurrent, NOW + 2))
        .to.emit(attestor, "ComplianceAttested")
        .withArgs(ASSET_A, alice.address, CURRENT_NULLIFIER, NOW + 2, CURRENT_EPOCH_END);
    });

    it("sólo vigila al mismo titular y al mismo activo", async () => {
      const { attestor, alice, bob, platform } = await loadFixture(deployComplianceStack);

      await attestForAt(attestor, platform, alice.address, proofs.aliceNextPeriod);
      await expect(attestForAt(attestor, platform, alice.address, proofs.aliceOnAssetB, NOW + 1)).to.emit(
        attestor,
        "ComplianceAttested",
      );
      await expect(attestForAt(attestor, platform, bob.address, proofs.bobCurrent, NOW + 2)).to.emit(
        attestor,
        "ComplianceAttested",
      );
    });
  });

  describe("precondición: las raíces salen del estado del registro", () => {
    it("acepta una raíz de credenciales sustituida dentro de la ventana", async () => {
      const { attestor, alice, registry } = await loadFixture(deployComplianceStack);

      expect(await registry.credentialRoot()).to.not.equal(INITIAL_ROOT);
      await expect(attestAt(attestor, alice, proofs.aliceSupersededRoot)).to.emit(attestor, "ComplianceAttested");
    });

    it("rechaza una raíz de credenciales fuera de la ventana", async () => {
      const { attestor, admin, alice, registry } = await loadFixture(deployComplianceStack);

      await time.setNextBlockTimestamp(NOW - 1);
      await registry.connect(admin).setRootValidityWindow(NOW - ROOT_SUPERSEDED_AT - 1);

      await expect(attestAt(attestor, alice, proofs.aliceSupersededRoot))
        .to.be.revertedWithCustomError(attestor, "CredentialRootNotValid")
        .withArgs(INITIAL_ROOT);
    });

    it("rechaza una raíz de credenciales invalidada aunque la ventana siga abierta", async () => {
      const { attestor, alice, issuer, registry } = await loadFixture(deployComplianceStack);

      await registry.connect(issuer).invalidateCredentialRoot(INITIAL_ROOT);

      await expect(attestAt(attestor, alice, proofs.aliceSupersededRoot))
        .to.be.revertedWithCustomError(attestor, "CredentialRootNotValid")
        .withArgs(INITIAL_ROOT);
    });

    it("rechaza una raíz de credenciales que nunca se publicó", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      await expect(
        attestAt(attestor, alice, proofs.aliceCurrent, NOW, shift(proofs.aliceCurrent.signals, 0, 1n)),
      ).to.be.revertedWithCustomError(attestor, "CredentialRootNotValid");
    });

    it("rechaza la raíz de jurisdicciones de otro activo", async () => {
      const { attestor, alice, registry } = await loadFixture(deployComplianceStack);

      expect(await registry.countryRootOf(ASSET_B)).to.equal(COUNTRY_ROOT_B);
      await expect(attestAt(attestor, alice, proofs.aliceForeignCountryRoot))
        .to.be.revertedWithCustomError(attestor, "CountryRootNotValid")
        .withArgs(ASSET_A, COUNTRY_ROOT_B);
    });

    it("rechaza un activo sin raíz de jurisdicciones publicada", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);
      const signals = [...proofs.aliceCurrent.signals];
      signals[2] = "0x" + (999n).toString(16).padStart(64, "0");

      await expect(attestAt(attestor, alice, proofs.aliceCurrent, NOW, signals))
        .to.be.revertedWithCustomError(attestor, "AssetNotRegistered")
        .withArgs(999n);
    });

    it("acepta una raíz de jurisdicciones sustituida dentro de la ventana", async () => {
      const { attestor, alice, jurisdiction, registry } = await loadFixture(deployComplianceStack);

      await time.setNextBlockTimestamp(NOW - 10);
      await registry.connect(jurisdiction).publishCountryRoot(ASSET_B, 12345n, []);

      await expect(attestAt(attestor, alice, proofs.aliceOnAssetB)).to.emit(attestor, "ComplianceAttested");
    });

    it("rechaza una raíz de jurisdicciones sustituida fuera de la ventana", async () => {
      const { attestor, admin, alice, jurisdiction, registry } = await loadFixture(deployComplianceStack);

      await time.setNextBlockTimestamp(NOW - 10);
      await registry.connect(jurisdiction).publishCountryRoot(ASSET_B, 12345n, []);
      await registry.connect(admin).setRootValidityWindow(5);

      await expect(attestAt(attestor, alice, proofs.aliceOnAssetB))
        .to.be.revertedWithCustomError(attestor, "CountryRootNotValid")
        .withArgs(ASSET_B, COUNTRY_ROOT_B);
    });
  });

  describe("precondición: el nulificador es de un solo uso por periodo", () => {
    it("rechaza la reutilización del mismo nulificador", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await expect(attestAt(attestor, alice, proofs.aliceCurrent, NOW + 1))
        .to.be.revertedWithCustomError(attestor, "NullifierAlreadySpent")
        .withArgs(ALICE_NULLIFIER);
    });

    it("una prueba contra una raíz anterior no reabre un nulificador gastado", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await expect(
        attestAt(attestor, alice, proofs.aliceSupersededRoot, NOW + 1),
      ).to.be.revertedWithCustomError(attestor, "NullifierAlreadySpent");
    });

    it("el gasto es atómico: una prueba inválida no deja el nulificador marcado", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);
      const tampered = { ...proofs.aliceCurrent, c: [proofs.aliceCurrent.c[0], proofs.aliceCurrent.c[1]] };
      tampered.c[0] = "0x" + (BigInt(proofs.aliceCurrent.c[0]) + 1n).toString(16).padStart(64, "0");

      await expect(attestAt(attestor, alice, tampered)).to.be.revertedWithCustomError(attestor, "InvalidProof");
      expect(await attestor.isNullifierSpent(ALICE_NULLIFIER)).to.equal(false);
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(false);
    });
  });

  describe("precondición: toda señal pública está en el campo", () => {
    it("rechaza un nulificador desplazado por el orden del campo", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      await expect(attestAt(attestor, alice, proofs.aliceCurrent, NOW, shift(proofs.aliceCurrent.signals, 4, SCALAR_FIELD)))
        .to.be.revertedWithCustomError(attestor, "PublicSignalOutOfField")
        .withArgs(4, ALICE_NULLIFIER + SCALAR_FIELD);
    });

    it("comprueba las seis señales, no sólo el nulificador", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);

      for (let index = 0; index < 6; index++) {
        const shifted = shift(proofs.aliceCurrent.signals, index, SCALAR_FIELD);
        await expect(attestAt(attestor, alice, proofs.aliceCurrent, NOW + index, shifted))
          .to.be.revertedWithCustomError(attestor, "PublicSignalOutOfField")
          .withArgs(index, BigInt(proofs.aliceCurrent.signals[index]) + SCALAR_FIELD);
      }
    });

    it("rechaza antes de llegar al verificador, no porque el verificador vaya a rechazarlo", async () => {
      const { attestor, alice, verifier } = await loadFixture(deployComplianceStack);
      const shifted = shift(proofs.aliceCurrent.signals, 4, SCALAR_FIELD);

      expect(
        await verifier.verifyProof(
          proofs.aliceCurrent.a as any,
          proofs.aliceCurrent.b as any,
          proofs.aliceCurrent.c as any,
          shifted as any,
        ),
      ).to.equal(false);
      await expect(attestAt(attestor, alice, proofs.aliceCurrent, NOW, shifted)).to.be.revertedWithCustomError(
        attestor,
        "PublicSignalOutOfField",
      );
    });
  });

  describe("precondición: la prueba verifica", () => {
    it("rechaza una prueba manipulada", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);
      const tampered = { ...proofs.aliceCurrent, a: [proofs.aliceCurrent.a[0], proofs.aliceCurrent.a[1]] };
      tampered.a[1] = "0x" + (BigInt(proofs.aliceCurrent.a[1]) + 1n).toString(16).padStart(64, "0");

      await expect(attestAt(attestor, alice, tampered)).to.be.revertedWithCustomError(attestor, "InvalidProof");
    });

    it("rechaza el nulificador de otro inversor sobre una prueba ajena", async () => {
      const { attestor, alice } = await loadFixture(deployComplianceStack);
      const swapped = [...proofs.aliceCurrent.signals];
      swapped[4] = proofs.bobCurrent.signals[4];

      await expect(attestAt(attestor, alice, proofs.aliceCurrent, NOW, swapped)).to.be.revertedWithCustomError(
        attestor,
        "InvalidProof",
      );
    });
  });

  describe("la atestación no sobrevive a la credencial", () => {
    it("una credencial que muere con el periodo lo atestigua entero y ni un segundo más", async () => {
      const { attestor, carla } = await loadFixture(deployComplianceStack);

      await expect(attestAt(attestor, carla, proofs.carlaCurrent))
        .to.emit(attestor, "ComplianceAttested")
        .withArgs(ASSET_A, carla.address, BigInt(proofs.carlaCurrent.signals[4]), NOW, CURRENT_EPOCH_END);

      await time.increaseTo(CURRENT_EPOCH_END - 1);
      expect(await attestor.isAttested(ASSET_A, carla.address)).to.equal(true);
      await time.increaseTo(CURRENT_EPOCH_END);
      expect(await attestor.isAttested(ASSET_A, carla.address)).to.equal(false);
    });

    it("no existe prueba de renovación para ella: el circuito la rechaza antes de llegar aquí", async () => {
      expect(Object.keys(proofs)).to.not.include("carlaNextPeriod");
      expect(BigInt(proofs.carlaCurrent.signals[3])).to.equal(BigInt(CURRENT_EPOCH_END));
    });
  });

  describe("vigencia y revocación", () => {
    it("el gestor puede revocarla antes de que caduque, sin liberar el nulificador", async () => {
      const { attestor, admin, alice } = await loadFixture(deployComplianceStack);

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await expect(attestor.connect(admin).revokeAttestation(ASSET_A, alice.address))
        .to.emit(attestor, "AttestationRevoked")
        .withArgs(ASSET_A, alice.address, ALICE_NULLIFIER);

      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(false);
      expect(await attestor.isNullifierSpent(ALICE_NULLIFIER)).to.equal(true);
    });

    it("sólo el gestor revoca, y sólo atestaciones existentes", async () => {
      const { attestor, admin, alice, outsider } = await loadFixture(deployComplianceStack);

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await expect(attestor.connect(outsider).revokeAttestation(ASSET_A, alice.address)).to.be.revertedWith(
        /AccessControl: account .* is missing role/,
      );
      await expect(attestor.connect(admin).revokeAttestation(ASSET_A, outsider.address))
        .to.be.revertedWithCustomError(attestor, "NoAttestation")
        .withArgs(ASSET_A, outsider.address);
    });

    it("la longitud de época es configurable y está acotada por los dos lados", async () => {
      const { attestor, admin, outsider } = await loadFixture(deployComplianceStack);
      const minLength = await attestor.MIN_EPOCH_LENGTH();
      const maxLength = await attestor.MAX_EPOCH_LENGTH();

      await expect(attestor.connect(outsider).setEpochLength(minLength)).to.be.revertedWith(
        /AccessControl: account .* is missing role/,
      );
      await expect(attestor.connect(admin).setEpochLength(maxLength + 1n))
        .to.be.revertedWithCustomError(attestor, "EpochLengthOutOfRange")
        .withArgs(maxLength + 1n, minLength, maxLength);
      await expect(attestor.connect(admin).setEpochLength(minLength - 1n))
        .to.be.revertedWithCustomError(attestor, "EpochLengthOutOfRange")
        .withArgs(minLength - 1n, minLength, maxLength);
      await expect(attestor.connect(admin).setEpochLength(7 * 24 * 3600))
        .to.emit(attestor, "EpochLengthUpdated")
        .withArgs(EPOCH_LENGTH, 7 * 24 * 3600);
    });

    it("acortar la época mueve todas las fronteras y caduca las pruebas ya construidas", async () => {
      const { attestor, admin, alice } = await loadFixture(deployComplianceStack);

      await time.setNextBlockTimestamp(NOW - 1);
      await attestor.connect(admin).setEpochLength(7 * 24 * 3600);

      await time.increaseTo(NOW);
      expect(await attestor.currentEpochEnd()).to.not.equal(CURRENT_EPOCH_END);
      await expect(attestAt(attestor, alice, proofs.aliceCurrent, NOW + 1)).to.be.revertedWithCustomError(
        attestor,
        "EpochEndNotCurrent",
      );
    });
  });
});
