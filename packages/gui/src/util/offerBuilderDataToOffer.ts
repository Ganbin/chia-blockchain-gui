import type { Wallet } from '@chia-network/api';
import { WalletType } from '@chia-network/api';
import { chiaToMojo, catToMojo } from '@chia-network/core';
import { t } from '@lingui/macro';
import BigNumber from 'bignumber.js';

import type Driver from '../@types/Driver';
import type OfferBuilderData from '../@types/OfferBuilderData';
import type { OfferTradeRecordFormatted } from '../hooks/useWalletOffers';
import findCATWalletByAssetId from './findCATWalletByAssetId';
import { getBalance, WalletBalanceFormatted } from './hasSpendableBalance';
import { prepareNFTOfferFromNFTId } from './prepareNFTOffer';

// Status of existing offer
// A combination of `type` and `assetId` must be unique through an array of `OfferStatus`.
export type OfferStatus = {
  type: 'XCH' | 'CAT' | 'SINGLETON';
  assetId?: string;
  assetName?: string; // Used just for labeling
  nftId?: string;
  lockedAmount: BigNumber;
  spendingAmount: BigNumber;
  shouldCancel: boolean;
  // - alsoUsedInNewOfferWithoutConflict
  //   The same asset is also offered in new offer but the amount is sufficient.
  //   Even existing offers are all settled, new offer won't fail because of lacked coin amount.
  // - conflictsWithNewOffer
  //   The same asset is also offered in new offer and only one of existing offers or new offer
  //   can be settled because not enough amount is spendable.
  status: '' | 'alsoUsedInNewOfferWithoutConflict' | 'conflictsWithNewOffer';
  relevantOffers: OfferTradeRecordFormatted[];
};

// Amount exceeds spendable balance
export default async function offerBuilderDataToOffer(
  data: OfferBuilderData,
  wallets: Wallet[],
  offers: OfferTradeRecordFormatted[],
  validateOnly?: boolean
): Promise<{
  walletIdsAndAmounts?: Record<string, BigNumber>;
  driverDict?: Record<string, any>;
  feeInMojos: BigNumber;
  validateOnly?: boolean;
  offersToCancel: OfferStatus[];
}> {
  const {
    offered: { xch: offeredXch = [], tokens: offeredTokens = [], nfts: offeredNfts = [], fee: [firstFee] = [] },
    requested: { xch: requestedXch = [], tokens: requestedTokens = [], nfts: requestedNfts = [] },
  } = data;

  const usedNFTs: string[] = [];

  const feeInMojos = firstFee ? chiaToMojo(firstFee.amount) : new BigNumber(0);

  const walletIdsAndAmounts: Record<string, BigNumber> = {};
  const driverDict: Record<string, Driver> = {};

  const hasOffer = !!offeredXch.length || !!offeredTokens.length || !!offeredNfts.length;

  if (!hasOffer) {
    throw new Error(t`Please specify at least one offered asset`);
  }

  const pendingOffers: OfferStatus[] = [];

  for (let i = 0; i < offers.length; i++) {
    const o = offers[i];
    if (o.isMyOffer && o.status === 'PENDING_ACCEPT') {
      const assetIds = Object.keys(o.pending) as string[];
      for (let k = 0; k < assetIds.length; k++) {
        const assetId = assetIds[k];
        const lockedAmount = new BigNumber(o.pending[assetId]);
        if (assetId.toUpperCase() === 'XCH' || assetId.toUpperCase() === 'UNKNOWN') {
          // 'UNKNOWN' is the diff between removals and additions of coins in this offer
          // It is assumed to be the amount of the 'fee'
          const idx = pendingOffers.findIndex((po) => po.type === 'XCH');
          if (idx > -1) {
            pendingOffers[idx].lockedAmount = pendingOffers[idx].lockedAmount.plus(lockedAmount);
            pendingOffers[idx].relevantOffers.push(o);
          } else {
            pendingOffers.push({
              type: 'XCH',
              assetName: 'XCH',
              lockedAmount,
              status: '',
              spendingAmount: new BigNumber(0),
              relevantOffers: [o],
              shouldCancel: false,
            });
          }
        } else {
          const info = o.summary.infos[assetId];
          const type = info.type.toUpperCase() as 'CAT' | 'SINGLETON';
          const idx = pendingOffers.findIndex((po) => po.type === type && po.assetId === assetId);
          if (idx > -1) {
            pendingOffers[idx].lockedAmount = pendingOffers[idx].lockedAmount.plus(lockedAmount);
            pendingOffers[idx].relevantOffers.push(o);
          } else {
            pendingOffers.push({
              type,
              assetId,
              lockedAmount,
              status: '',
              spendingAmount: new BigNumber(0),
              relevantOffers: [o],
              shouldCancel: false,
            });
          }
        }
      }
    }
  }

  let standardWallet: Wallet | undefined;
  let standardWalletBalance: WalletBalanceFormatted | undefined;
  let pendingXchOffer: OfferStatus | undefined;
  let pendingXch = new BigNumber(0);
  if (offeredXch.length > 0) {
    standardWallet = wallets.find((w) => w.type === WalletType.STANDARD_WALLET);
    for (let i = 0; i < pendingOffers.length; i++) {
      const po = pendingOffers[i];
      if (po.type === 'XCH') {
        pendingXchOffer = po;
        pendingXch = po.lockedAmount;
        break;
      }
    }
    if (standardWallet) {
      standardWalletBalance = await getBalance(standardWallet.id);
    }
  }

  // offeredXch.length should be always `1`
  const xchTasks = offeredXch.map(async (xch) => {
    const { amount } = xch;
    if (!amount || amount === '0') {
      throw new Error(t`Please enter an XCH amount`);
    }
    if (!standardWallet || !standardWalletBalance) {
      throw new Error(t`No standard wallet found`);
    }

    const mojoAmount = chiaToMojo(amount);
    walletIdsAndAmounts[standardWallet.id] = mojoAmount.negated();

    const spendableBalance = new BigNumber(standardWalletBalance.spendableBalance);
    const hasEnoughTotalBalance = spendableBalance.plus(pendingXch).gte(mojoAmount);
    if (!hasEnoughTotalBalance) {
      throw new Error(t`Amount exceeds XCH total balance`);
    }

    if (pendingXchOffer) {
      pendingXchOffer.spendingAmount = mojoAmount; // Assuming offeredXch.length is always `1`
      const hasEnoughSpendableBalance = spendableBalance.gte(mojoAmount); // Assuming offeredXch.length is always `1`
      if (!hasEnoughSpendableBalance) {
        pendingXchOffer.status = 'conflictsWithNewOffer';
      } else {
        pendingXchOffer.status = 'alsoUsedInNewOfferWithoutConflict';
      }
    }
  });

  const tokenTasks = offeredTokens.map(async (token) => {
    const { assetId, amount } = token;

    if (!assetId) {
      throw new Error(t`Please select an asset for each token`);
    }

    const catWallet = findCATWalletByAssetId(wallets, assetId);
    if (!catWallet) {
      throw new Error(t`No CAT wallet found for ${assetId} token`);
    }

    const catName = catWallet.meta?.name || 'Unknown token';

    if (!amount || amount === '0') {
      throw new Error(t`Please enter an amount for ${catName} token`);
    }

    const mojoAmount = catToMojo(amount);
    walletIdsAndAmounts[catWallet.id] = mojoAmount.negated();

    const pendingCatOffer = pendingOffers.find((po) => po.type === 'CAT' && po.assetId === assetId);
    const pendingCat = pendingCatOffer ? pendingCatOffer.lockedAmount : new BigNumber(0);

    const walletBalance = await getBalance(catWallet.id);
    const spendableBalance = new BigNumber(walletBalance.spendableBalance);
    const hasEnoughTotalBalance = spendableBalance.plus(pendingCat).gte(mojoAmount);
    if (!hasEnoughTotalBalance) {
      throw new Error(t`Amount exceeds total balance for ${catName} token`);
    }

    if (pendingCatOffer) {
      pendingCatOffer.spendingAmount = mojoAmount; // Assuming no duplicate of `assetId` exists in `offeredTokens`
      pendingCatOffer.assetName = catName;
      const hasEnoughSpendableBalance = spendableBalance.gte(mojoAmount);
      if (!hasEnoughSpendableBalance) {
        pendingCatOffer.status = 'conflictsWithNewOffer';
      } else {
        pendingCatOffer.status = 'alsoUsedInNewOfferWithoutConflict';
      }
    }
  });

  const nftTasks = offeredNfts.map(async ({ nftId }) => {
    if (usedNFTs.includes(nftId)) {
      throw new Error(t`NFT ${nftId} is already used in this offer`);
    }
    usedNFTs.push(nftId);

    const { id, amount, driver } = await prepareNFTOfferFromNFTId(nftId, true);

    walletIdsAndAmounts[id] = amount;
    if (driver) {
      driverDict[id] = driver;
    }

    const pendingNft = pendingOffers.find((po) => po.type === 'SINGLETON' && po.assetId === id);
    if (pendingNft) {
      pendingNft.nftId = nftId;
      pendingNft.spendingAmount = new BigNumber(1);
      pendingNft.assetName = `NFT ${nftId}`;
      // Currently offered NFT is not locked upon creating offer so status should be 'alsoUsedInNewOfferWithoutConflict'.
      pendingNft.status = 'alsoUsedInNewOfferWithoutConflict';
    }
  });

  await Promise.all([...xchTasks, ...tokenTasks, ...nftTasks]);

  // requested
  requestedXch.forEach((xch) => {
    const { amount } = xch;

    // For one-sided offers where nothing is requested, we allow the amount to be '0'
    // and skip adding an entry to the walletIdsAndAmounts object.
    //
    // If the amount is blank '', we prompt the user to enter an amount.
    if (amount === '0') {
      return;
    }

    if (!amount) {
      throw new Error(t`Please enter an XCH amount`);
    }

    const wallet = wallets.find((w) => w.type === WalletType.STANDARD_WALLET);
    if (!wallet) {
      throw new Error(t`No standard wallet found`);
    }

    if (wallet.id in walletIdsAndAmounts) {
      throw new Error(t`Cannot offer and request the same asset`);
    }

    walletIdsAndAmounts[wallet.id] = chiaToMojo(amount);
  });

  requestedTokens.forEach((token) => {
    const { assetId, amount } = token;

    if (!assetId) {
      throw new Error(t`Please select an asset for each token`);
    }

    const wallet = findCATWalletByAssetId(wallets, assetId);
    if (!wallet) {
      throw new Error(t`No CAT wallet found for ${assetId} token`);
    }

    if (!amount || amount === '0') {
      throw new Error(t`Please enter an amount for ${wallet.meta?.name} token`);
    }

    walletIdsAndAmounts[wallet.id] = catToMojo(amount);
  });

  const prepareNftTasks = requestedNfts.map(async ({ nftId }) => {
    if (usedNFTs.includes(nftId)) {
      throw new Error(t`NFT ${nftId} is already used in this offer`);
    }
    usedNFTs.push(nftId);

    const { id, amount, driver } = await prepareNFTOfferFromNFTId(nftId, false);

    walletIdsAndAmounts[id] = amount;
    if (driver) {
      driverDict[id] = driver;
    }
  });

  await Promise.all(prepareNftTasks);

  return {
    walletIdsAndAmounts,
    driverDict,
    feeInMojos,
    validateOnly,
    offersToCancel: pendingOffers.filter((po) => po.spendingAmount.gt(0)),
  };
}
