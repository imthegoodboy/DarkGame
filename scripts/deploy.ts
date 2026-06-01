import fs from "node:fs";
import path from "node:path";
import hre from "hardhat";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();

  console.log(`Deploying DarkGame from ${deployer.address}`);
  console.log(`Network: ${network.name} (${network.chainId})`);

  const DarkGame = await hre.ethers.getContractFactory("DarkGame");
  const darkGame = await DarkGame.deploy();
  const deploymentTx = darkGame.deploymentTransaction();
  await darkGame.waitForDeployment();
  const receipt = deploymentTx ? await deploymentTx.wait() : null;

  const address = await darkGame.getAddress();
  const output = {
    contract: "DarkGame",
    address,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    transactionHash: deploymentTx?.hash ?? null,
    blockNumber: receipt?.blockNumber ?? null,
    deployedAt: new Date().toISOString(),
  };

  const deploymentsDir = path.join(process.cwd(), "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });

  const suffix = network.chainId === 31337n ? "local" : String(network.chainId);
  const outputPath = path.join(deploymentsDir, `${suffix}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`DarkGame deployed to ${address}`);
  console.log(`Deployment metadata written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
