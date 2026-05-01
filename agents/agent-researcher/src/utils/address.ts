import { ethers } from "ethers";

export function toChecksumSafe(address: string): string {
  try {
    return ethers.getAddress(address);
  } catch {
    return address;
  }
}
