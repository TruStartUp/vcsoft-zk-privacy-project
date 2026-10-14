import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  ASSET_A,
  ASSET_B,
  NOW,
  ROOT_SUPERSEDED_AT,
  ROOT_VALIDITY_WINDOW,
  SCALAR_FIELD,
  countryLeafArgs,
  credentialLeafArgs,
  deployComplianceStack,
  fixture,
} from "./helpers";

const INITIAL_ROOT = BigInt(fixture.roots.credentialInitial);
const CURRENT_ROOT = BigInt(fixture.roots.credentialCurrent);
const COUNTRY_ROOT_A = BigInt(fixture.roots.countryA);
const COUNTRY_ROOT_B = BigInt(fixture.roots.countryB);
const ANOTHER_ROOT = 7n;

describe("CredentialRegistry", () => {
  it("se despliega con la ventana de validez documentada por defecto", async () => {
    const { registry } = await loadFixture(deployComplianceStack);

    expect(await registry.DEFAULT_ROOT_VALIDITY_WINDOW()).to.equal(ROOT_VALIDITY_WINDOW);
    expect(await registry.rootValidityWindow()).to.equal(ROOT_VALIDITY_WINDOW);
  });

  describe("control de acceso", () => {
    it("solo el emisor publica la raíz de credenciales", async () => {
      const { registry, outsider, issuer } = await loadFixture(deployComplianceStack);

      await expect(registry.connect(outsider).publishCredentialRoot(ANOTHER_ROOT, [])).to.be.revertedWith(
        /AccessControl: account .* is missing role/,
      );
      await expect(registry.connect(issuer).publishCredentialRoot(ANOTHER_ROOT, [])).to.emit(
        registry,
        "CredentialRootPublished",
      );
    });

    it("solo el administrador de jurisdicciones publica la raíz de países", async () => {
      const { registry, issuer, jurisdiction } = await loadFixture(deployComplianceStack);

      await expect(registry.connect(issuer).publishCountryRoot(ASSET_A, ANOTHER_ROOT, [])).to.be.revertedWith(
        /AccessControl: account .* is missing role/,
      );
      await expect(registry.connect(jurisdiction).publishCountryRoot(ASSET_A, ANOTHER_ROOT, [])).to.emit(
        registry,
        "CountryRootPublished",
      );
    });

    it("solo el administrador cambia la ventana de validez", async () => {
      const { registry, admin, issuer } = await loadFixture(deployComplianceStack);

      await expect(registry.connect(issuer).setRootValidityWindow(60)).to.be.revertedWith(
        /AccessControl: account .* is missing role/,
      );
      await expect(registry.connect(admin).setRootValidityWindow(60))
        .to.emit(registry, "RootValidityWindowUpdated")
        .withArgs(ROOT_VALIDITY_WINDOW, 60);
    });
  });

  describe("reconstrucción del árbol fuera de la cadena", () => {
    it("emite cada hoja emitida y cada hoja revocada con su raíz", async () => {
      const { registry, issuer } = await loadFixture(deployComplianceStack);
      const revokedCommitment = BigInt(fixture.credentialLeaves.initial[0].commitment);

      await expect(
        registry
          .connect(issuer)
          .publishCredentialRoot(ANOTHER_ROOT, credentialLeafArgs(fixture.credentialLeaves.initial, false)),
      )
        .to.emit(registry, "CredentialLeafUpdated")
        .withArgs(ANOTHER_ROOT, 0, revokedCommitment, false);
    });

    it("emite cada jurisdicción admitida o retirada con su raíz", async () => {
      const { registry, jurisdiction } = await loadFixture(deployComplianceStack);

      await expect(
        registry
          .connect(jurisdiction)
          .publishCountryRoot(ASSET_A, ANOTHER_ROOT, countryLeafArgs([{ leafIndex: 1, countryCode: 250 }], false)),
      )
        .to.emit(registry, "CountryLeafUpdated")
        .withArgs(ASSET_A, ANOTHER_ROOT, 1, 250, false);
    });
  });

  describe("ventana de validez de las raíces", () => {
    it("la raíz vigente vale siempre, sin importar su antigüedad", async () => {
      const { registry } = await loadFixture(deployComplianceStack);

      await time.increaseTo(NOW + 10 * ROOT_VALIDITY_WINDOW);

      expect(await registry.credentialRoot()).to.equal(CURRENT_ROOT);
      expect(await registry.isCredentialRootValid(CURRENT_ROOT)).to.equal(true);
    });

    it("una raíz sustituida sigue valiendo dentro de la ventana", async () => {
      const { registry } = await loadFixture(deployComplianceStack);

      await time.increaseTo(ROOT_SUPERSEDED_AT + ROOT_VALIDITY_WINDOW);

      expect(await registry.credentialRootSupersededAt(INITIAL_ROOT)).to.equal(ROOT_SUPERSEDED_AT);
      expect(await registry.isCredentialRootValid(INITIAL_ROOT)).to.equal(true);
    });

    it("una raíz sustituida deja de valer un segundo después de la ventana", async () => {
      const { registry } = await loadFixture(deployComplianceStack);

      await time.increaseTo(ROOT_SUPERSEDED_AT + ROOT_VALIDITY_WINDOW + 1);

      expect(await registry.isCredentialRootValid(INITIAL_ROOT)).to.equal(false);
    });

    it("acortar la ventana caduca al instante las raíces ya sustituidas", async () => {
      const { registry, admin } = await loadFixture(deployComplianceStack);

      await time.setNextBlockTimestamp(NOW - 1);
      await registry.connect(admin).setRootValidityWindow(30);
      await time.increaseTo(NOW);

      expect(await registry.isCredentialRootValid(INITIAL_ROOT)).to.equal(false);
    });

    it("invalidar una raíz lleva la latencia de revocación a cero", async () => {
      const { registry, issuer } = await loadFixture(deployComplianceStack);

      expect(await registry.isCredentialRootValid(INITIAL_ROOT)).to.equal(true);
      await expect(registry.connect(issuer).invalidateCredentialRoot(INITIAL_ROOT))
        .to.emit(registry, "CredentialRootInvalidated")
        .withArgs(INITIAL_ROOT);
      expect(await registry.isCredentialRootValid(INITIAL_ROOT)).to.equal(false);
    });

    it("no permite invalidar la raíz vigente ni una desconocida", async () => {
      const { registry, issuer } = await loadFixture(deployComplianceStack);

      await expect(registry.connect(issuer).invalidateCredentialRoot(CURRENT_ROOT))
        .to.be.revertedWithCustomError(registry, "RootIsCurrent")
        .withArgs(CURRENT_ROOT);
      await expect(registry.connect(issuer).invalidateCredentialRoot(ANOTHER_ROOT))
        .to.be.revertedWithCustomError(registry, "UnknownRoot")
        .withArgs(ANOTHER_ROOT);
    });

    it("la ventana está acotada por arriba", async () => {
      const { registry, admin } = await loadFixture(deployComplianceStack);
      const maxWindow = await registry.MAX_ROOT_VALIDITY_WINDOW();

      await expect(registry.connect(admin).setRootValidityWindow(maxWindow + 1n))
        .to.be.revertedWithCustomError(registry, "WindowTooLong")
        .withArgs(maxWindow + 1n, maxWindow);
      await expect(
        (await ethers.getContractFactory("CredentialRegistry")).deploy(admin.address, maxWindow + 1n),
      ).to.be.revertedWithCustomError(registry, "WindowTooLong");
    });
  });

  describe("aislamiento entre activos", () => {
    it("la raíz de jurisdicciones de un activo no vale para otro", async () => {
      const { registry } = await loadFixture(deployComplianceStack);

      expect(await registry.isCountryRootValid(ASSET_A, COUNTRY_ROOT_A)).to.equal(true);
      expect(await registry.isCountryRootValid(ASSET_B, COUNTRY_ROOT_B)).to.equal(true);
      expect(await registry.isCountryRootValid(ASSET_A, COUNTRY_ROOT_B)).to.equal(false);
      expect(await registry.isCountryRootValid(ASSET_B, COUNTRY_ROOT_A)).to.equal(false);
    });

    it("un activo sin raíz publicada no admite ninguna raíz", async () => {
      const { registry } = await loadFixture(deployComplianceStack);

      expect(await registry.countryRootOf(999n)).to.equal(0n);
      expect(await registry.isCountryRootValid(999n, COUNTRY_ROOT_A)).to.equal(false);
      expect(await registry.isCountryRootValid(999n, 0n)).to.equal(false);
    });
  });

  describe("saneamiento de entradas", () => {
    it("rechaza raíces fuera del campo y raíces nulas", async () => {
      const { registry, issuer } = await loadFixture(deployComplianceStack);

      await expect(registry.connect(issuer).publishCredentialRoot(SCALAR_FIELD, []))
        .to.be.revertedWithCustomError(registry, "NotAFieldElement")
        .withArgs(SCALAR_FIELD);
      await expect(registry.connect(issuer).publishCredentialRoot(0n, [])).to.be.revertedWithCustomError(
        registry,
        "ZeroRoot",
      );
      await expect(registry.connect(issuer).publishCredentialRoot(CURRENT_ROOT, []))
        .to.be.revertedWithCustomError(registry, "RootUnchanged")
        .withArgs(CURRENT_ROOT);
    });

    it("rechaza índices de hoja fuera de la profundidad del circuito", async () => {
      const { registry, issuer, jurisdiction } = await loadFixture(deployComplianceStack);

      await expect(
        registry
          .connect(issuer)
          .publishCredentialRoot(ANOTHER_ROOT, [{ leafIndex: 1 << 20, commitment: 1n, inserted: true }]),
      )
        .to.be.revertedWithCustomError(registry, "LeafIndexOutOfRange")
        .withArgs(1 << 20, 20);

      await expect(
        registry
          .connect(jurisdiction)
          .publishCountryRoot(ASSET_A, ANOTHER_ROOT, [{ leafIndex: 256, countryCode: 724, admitted: true }]),
      )
        .to.be.revertedWithCustomError(registry, "LeafIndexOutOfRange")
        .withArgs(256, 8);
    });

    it("rechaza la hoja de relleno como código de país", async () => {
      const { registry, jurisdiction } = await loadFixture(deployComplianceStack);

      await expect(
        registry
          .connect(jurisdiction)
          .publishCountryRoot(ASSET_A, ANOTHER_ROOT, [{ leafIndex: 3, countryCode: 0, admitted: true }]),
      )
        .to.be.revertedWithCustomError(registry, "PaddingCountryCode")
        .withArgs(3);
    });

    it("rechaza compromisos nulos o fuera del campo", async () => {
      const { registry, issuer } = await loadFixture(deployComplianceStack);

      await expect(
        registry.connect(issuer).publishCredentialRoot(ANOTHER_ROOT, [{ leafIndex: 0, commitment: 0n, inserted: true }]),
      ).to.be.revertedWithCustomError(registry, "ZeroCommitment");
      await expect(
        registry
          .connect(issuer)
          .publishCredentialRoot(ANOTHER_ROOT, [{ leafIndex: 0, commitment: SCALAR_FIELD, inserted: true }]),
      ).to.be.revertedWithCustomError(registry, "NotAFieldElement");
    });
  });
});
