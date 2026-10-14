import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre, { ethers } from "hardhat";

import { ASSET_A, attestForAt, deployComplianceStack, proofs } from "./helpers";
import { deployTrexSuite } from "./trex-suite";

/// The operator tasks, run through the Hardhat runtime exactly as the command line runs
/// them, against the in-process network.

describe("Tareas de operación", () => {
  describe("attestation:revoke", () => {
    async function attested() {
      const stack = await loadFixture(deployComplianceStack);
      await attestForAt(stack.attestor, stack.platform, stack.alice.address, proofs.aliceCurrent);
      return stack;
    }

    it("revoca la atestación viva con la cuenta que tiene el rol", async () => {
      const { attestor, alice } = await attested();
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);

      const result = await hre.run("attestation:revoke", {
        subject: alice.address,
        asset: ASSET_A.toString(),
        attestor: await attestor.getAddress(),
      });

      expect(result).to.include({ revoked: true, subject: alice.address });
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(false);
      expect((await attestor.attestationOf(ASSET_A, alice.address)).expiresAt).to.equal(0n);
    });

    it("no envía nada si no hay atestación, y lo dice", async () => {
      const { attestor, bob } = await attested();
      const blockBefore = await ethers.provider.getBlockNumber();

      const result = await hre.run("attestation:revoke", {
        subject: bob.address,
        asset: ASSET_A.toString(),
        attestor: await attestor.getAddress(),
      });

      expect(result).to.include({ revoked: false });
      expect(await ethers.provider.getBlockNumber()).to.equal(blockBefore);
    });

    it("en simulación comprueba y no envía", async () => {
      const { attestor, alice } = await attested();

      const result = await hre.run("attestation:revoke", {
        subject: alice.address,
        asset: ASSET_A.toString(),
        attestor: await attestor.getAddress(),
        dryRun: true,
      });

      expect(result).to.include({ revoked: false, dryRun: true });
      expect(await attestor.isAttested(ASSET_A, alice.address)).to.equal(true);
    });

    it("se niega si ninguna cuenta tiene el rol", async () => {
      const { attestor, admin, alice } = await attested();
      await attestor.connect(admin).revokeRole(await attestor.ATTESTATION_MANAGER_ROLE(), admin.address);

      await expect(
        hre.run("attestation:revoke", { subject: alice.address, asset: ASSET_A.toString(), attestor: await attestor.getAddress() }),
      ).to.be.rejectedWith("no local account holds ATTESTATION_MANAGER_ROLE");
    });

    it("sin dirección ni despliegue registrado, pide el atestador", async () => {
      const { alice } = await attested();
      await expect(hre.run("attestation:revoke", { subject: alice.address, asset: "1" })).to.be.rejectedWith("pass --attestor");
    });
  });

  describe("token:freeze y token:unfreeze", () => {
    async function holding() {
      const signers = await ethers.getSigners();
      const [owner, tokenAgent, claimIssuerOwner, claimSigningKey, investor, receiver] = signers.slice(12);
      const suite = await deployTrexSuite({ owner, tokenAgent, claimIssuerOwner, claimSigningKey });
      await suite.registerInvestor(investor, 170);
      await suite.registerInvestor(receiver, 170);
      await suite.token.connect(tokenAgent).mint(investor.address, ethers.parseUnits("100", 18));
      return { ...suite, tokenAgent, investor, receiver, tokenAddress: await suite.token.getAddress() };
    }

    it("congela la dirección, impide que envíe, y la descongela", async () => {
      const { token, investor, receiver, tokenAddress } = await loadFixture(holding);

      const frozen = await hre.run("token:freeze", { holder: investor.address, token: tokenAddress });
      expect(frozen).to.include({ changed: true, addressFrozen: true, balance: "100.0" });
      await expect(token.connect(investor).transfer(receiver.address, 1n)).to.be.reverted;

      const again = await hre.run("token:freeze", { holder: investor.address, token: tokenAddress });
      expect(again).to.include({ changed: false });

      const unfrozen = await hre.run("token:unfreeze", { holder: investor.address, token: tokenAddress });
      expect(unfrozen).to.include({ changed: true, addressFrozen: false });
      await token.connect(investor).transfer(receiver.address, 1n);
    });

    it("congela y descongela una parte del saldo", async () => {
      const { token, investor, receiver, tokenAddress } = await loadFixture(holding);

      const partial = await hre.run("token:freeze", { holder: investor.address, token: tokenAddress, amount: "40" });
      expect(partial).to.include({ changed: true, addressFrozen: false, frozenTokens: "40.0" });
      await expect(token.connect(investor).transfer(receiver.address, ethers.parseUnits("61", 18))).to.be.reverted;
      await token.connect(investor).transfer(receiver.address, ethers.parseUnits("60", 18));

      const released = await hre.run("token:unfreeze", { holder: investor.address, token: tokenAddress, amount: "40" });
      expect(released).to.include({ frozenTokens: "0.0", balance: "40.0" });
    });

    it("rechaza congelar más de lo que hay sin congelar, sin enviar nada", async () => {
      const { investor, tokenAddress } = await loadFixture(holding);
      const blockBefore = await ethers.provider.getBlockNumber();

      await expect(
        hre.run("token:freeze", { holder: investor.address, token: tokenAddress, amount: "100.5" }),
      ).to.be.rejectedWith("exceeds the unfrozen balance");
      await expect(
        hre.run("token:unfreeze", { holder: investor.address, token: tokenAddress, amount: "1" }),
      ).to.be.rejectedWith("exceeds the frozen tokens");
      expect(await ethers.provider.getBlockNumber()).to.equal(blockBefore);
    });

    it("firma con el agente del token y no con otra cuenta", async () => {
      const { token, tokenAgent, investor, tokenAddress } = await loadFixture(holding);

      const result = await hre.run("token:freeze", { holder: investor.address, token: tokenAddress });
      const transaction = await ethers.provider.getTransaction(result.txHash);
      expect(transaction?.from).to.equal(tokenAgent.address);
      expect(await token.isAgent(tokenAgent.address)).to.equal(true);
    });
  });
});
