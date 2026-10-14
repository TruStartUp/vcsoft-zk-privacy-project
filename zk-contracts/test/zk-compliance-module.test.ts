import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  ASSET_A,
  ASSET_B,
  CURRENT_EPOCH_END,
  attestAt,
  deployComplianceStack,
  proofs,
} from "./helpers";

describe("ZKComplianceModule", () => {
  describe("configuración", () => {
    it("declara su nombre y su naturaleza de módulo ERC-3643", async () => {
      const { module } = await loadFixture(deployComplianceStack);

      expect(await module.name()).to.equal("ZKComplianceModule");
      expect(await module.isPlugAndPlay()).to.equal(true);
      expect(await module.canComplianceBind(ethers.ZeroAddress)).to.equal(true);
    });

    it("liga el activo a la compliance que lo declara, y sólo ella", async () => {
      const { module, complianceA, outsider } = await loadFixture(deployComplianceStack);

      expect(await module.assetIdOf(await complianceA.getAddress())).to.equal(ASSET_A);
      await expect(module.connect(outsider).setAssetId(ASSET_A)).to.be.revertedWith(
        "only bound compliance can call",
      );
    });

    it("rechaza el activo cero, que es el valor de «sin configurar»", async () => {
      const { module, complianceA } = await loadFixture(deployComplianceStack);

      await expect(complianceA.setAssetId(await module.getAddress(), 0)).to.be.revertedWithCustomError(
        module,
        "ZeroAssetId",
      );
    });

    it("un activo ya ligado no lo puede reclamar otra compliance", async () => {
      const { module, complianceA, unconfiguredCompliance } = await loadFixture(deployComplianceStack);
      const moduleAddress = await module.getAddress();

      expect(await module.complianceOfAsset(ASSET_A)).to.equal(await complianceA.getAddress());
      await expect(unconfiguredCompliance.setAssetId(moduleAddress, ASSET_A))
        .to.be.revertedWithCustomError(module, "AssetIdAlreadyBound")
        .withArgs(ASSET_A, await complianceA.getAddress());
      expect(await module.assetIdOf(await unconfiguredCompliance.getAddress())).to.equal(0n);
    });

    it("una compliance que cambia de activo libera el que tenía", async () => {
      const { module, complianceA, unconfiguredCompliance } = await loadFixture(deployComplianceStack);
      const moduleAddress = await module.getAddress();
      const newAsset = 4242n;

      await complianceA.setAssetId(moduleAddress, newAsset);
      expect(await module.assetIdOf(await complianceA.getAddress())).to.equal(newAsset);
      expect(await module.complianceOfAsset(ASSET_A)).to.equal(ethers.ZeroAddress);

      await expect(unconfiguredCompliance.setAssetId(moduleAddress, ASSET_A)).to.emit(module, "AssetIdSet");
      expect(await module.complianceOfAsset(ASSET_A)).to.equal(await unconfiguredCompliance.getAddress());
    });

    it("sólo el propietario libera un activo ligado, y sólo uno que lo esté", async () => {
      const { module, complianceA, admin, outsider } = await loadFixture(deployComplianceStack);

      await expect(module.connect(outsider).releaseAssetId(ASSET_A)).to.be.revertedWith(
        "Ownable: caller is not the owner",
      );
      await expect(module.connect(admin).releaseAssetId(999n))
        .to.be.revertedWithCustomError(module, "AssetIdNotBound")
        .withArgs(999n);

      await expect(module.connect(admin).releaseAssetId(ASSET_A))
        .to.emit(module, "AssetIdReleased")
        .withArgs(await complianceA.getAddress(), ASSET_A);
      expect(await module.assetIdOf(await complianceA.getAddress())).to.equal(0n);
      expect(await module.complianceOfAsset(ASSET_A)).to.equal(ethers.ZeroAddress);
    });

    it("una atestación no se cuela de un activo a otro por reclamar su identificador", async () => {
      const { attestor, module, complianceA, unconfiguredCompliance, alice, outsider } =
        await loadFixture(deployComplianceStack);
      const moduleAddress = await module.getAddress();

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await expect(unconfiguredCompliance.setAssetId(moduleAddress, ASSET_A)).to.be.revertedWithCustomError(
        module,
        "AssetIdAlreadyBound",
      );

      expect(await complianceA.check(moduleAddress, outsider.address, alice.address, 1)).to.equal(true);
      expect(await unconfiguredCompliance.check(moduleAddress, outsider.address, alice.address, 1)).to.equal(false);
    });

    it("sólo el propietario puede rotar el atestador", async () => {
      const { module, attestor, admin, outsider } = await loadFixture(deployComplianceStack);

      await expect(module.connect(outsider).setAttestor(outsider.address)).to.be.revertedWith(
        "Ownable: caller is not the owner",
      );
      await expect(module.connect(admin).setAttestor(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        module,
        "ZeroAddress",
      );
      await expect(module.connect(admin).setAttestor(await attestor.getAddress()))
        .to.emit(module, "AttestorSet")
        .withArgs(await attestor.getAddress());
    });

    it("las acciones de transferencia sólo las invoca una compliance ligada", async () => {
      const { module, complianceA, outsider } = await loadFixture(deployComplianceStack);
      const moduleAddress = await module.getAddress();

      await expect(module.connect(outsider).moduleTransferAction(outsider.address, outsider.address, 1)).to.be
        .revertedWith("only bound compliance can call");
      await expect(complianceA.transferAction(moduleAddress, outsider.address, outsider.address, 1)).to.not.be
        .reverted;
      await expect(complianceA.mintAction(moduleAddress, outsider.address, 1)).to.not.be.reverted;
      await expect(complianceA.burnAction(moduleAddress, outsider.address, 1)).to.not.be.reverted;
    });
  });

  describe("moduleCheck consulta la atestación viva", () => {
    it("deniega a una dirección sin atestación", async () => {
      const { module, complianceA, alice, outsider } = await loadFixture(deployComplianceStack);
      const moduleAddress = await module.getAddress();

      expect(await complianceA.check(moduleAddress, outsider.address, alice.address, 1)).to.equal(false);
      expect(await complianceA.check(moduleAddress, alice.address, outsider.address, 1)).to.equal(false);
    });

    it("admite al receptor una vez presentada la prueba", async () => {
      const { attestor, module, complianceA, alice, outsider } = await loadFixture(deployComplianceStack);
      const moduleAddress = await module.getAddress();

      await attestAt(attestor, alice, proofs.aliceCurrent);

      expect(await complianceA.check(moduleAddress, outsider.address, alice.address, 1)).to.equal(true);
    });

    it("deniega cuando la atestación caduca", async () => {
      const { attestor, module, complianceA, alice, outsider } = await loadFixture(deployComplianceStack);
      const moduleAddress = await module.getAddress();

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await time.increaseTo(CURRENT_EPOCH_END - 1);
      expect(await complianceA.check(moduleAddress, outsider.address, alice.address, 1)).to.equal(true);

      await time.increaseTo(CURRENT_EPOCH_END);
      expect(await complianceA.check(moduleAddress, outsider.address, alice.address, 1)).to.equal(false);
    });

    it("deniega cuando el gestor revoca la atestación", async () => {
      const { attestor, admin, module, complianceA, alice, outsider } = await loadFixture(deployComplianceStack);
      const moduleAddress = await module.getAddress();

      await attestAt(attestor, alice, proofs.aliceCurrent);
      await attestor.connect(admin).revokeAttestation(ASSET_A, alice.address);

      expect(await complianceA.check(moduleAddress, outsider.address, alice.address, 1)).to.equal(false);
    });

    it("una atestación de un activo no sirve para otro", async () => {
      const { attestor, module, complianceA, complianceB, alice, outsider } =
        await loadFixture(deployComplianceStack);
      const moduleAddress = await module.getAddress();

      await attestAt(attestor, alice, proofs.aliceCurrent);

      expect(await module.assetIdOf(await complianceB.getAddress())).to.equal(ASSET_B);
      expect(await complianceA.check(moduleAddress, outsider.address, alice.address, 1)).to.equal(true);
      expect(await complianceB.check(moduleAddress, outsider.address, alice.address, 1)).to.equal(false);
    });

    it("una compliance sin activo ligado no admite nada", async () => {
      const { attestor, module, unconfiguredCompliance, alice, outsider } =
        await loadFixture(deployComplianceStack);
      const moduleAddress = await module.getAddress();

      await attestAt(attestor, alice, proofs.aliceCurrent);

      expect(await module.assetIdOf(await unconfiguredCompliance.getAddress())).to.equal(0n);
      expect(await unconfiguredCompliance.check(moduleAddress, outsider.address, alice.address, 1)).to.equal(false);
    });
  });
});
