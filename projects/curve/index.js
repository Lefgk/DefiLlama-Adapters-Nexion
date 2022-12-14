const { unwrapYearn, sumTokensSharedOwners, nullAddress, sumTokens2, } = require("../helper/unwrapLPs");
const { getChainTransform } = require("../helper/portedTokens");
const { get } = require("../helper/http");
const { staking } = require("../helper/staking.js");
const BigNumber = require("bignumber.js");
const sdk = require("@defillama/sdk");
const abi = require("./abi.json");
const creamAbi = require("../helper/abis/cream.json");
const contracts = require("./contracts.json");
const chains = [
  "ethereum", //-200M
  "polygon", //-40M
  "arbitrum", //G
  "aurora", //G
  "avax", //-30M
  "fantom", //-80M
  "optimism", //-6M
  "xdai", //G
  "moonbeam",
  "celo",
  "kava"
]; // Object.keys(contracts);
const registryIds = {
  stableswap: 0,
  stableFactory: 3,
  crypto: 5,
  cryptoFactory: 6
};

const registryIdsReverse = Object.fromEntries(Object.entries(registryIds).map(i => i.reverse()))

async function getPool({ chain, block, registry }) {
  const data = await sdk.api2.abi.fetchList({ chain, block, target: registry, itemAbi: abi.pool_list, lengthAbi: abi.pool_count, withMetadata: true,  })
  return data.filter(i => i.output)
}

function getRegistryType(registryId) {
  if (!registryIdsReverse.hasOwnProperty(registryId)) throw new Error('Unknown registry id: ' + registryId)
  return registryIdsReverse[registryId]
}

async function getPools(block, chain) {
  let { registriesMapping } = contracts[chain]
  if (!registriesMapping) {
    registriesMapping = {};
    (await sdk.api.abi.multiCall({
      block, chain,
      calls: Object.values(registryIds).map(r => ({ params: r })),
      target: contracts[chain].addressProvider,
      abi: abi.get_id_info
    })).output
      .filter(r => r.output.addr !== nullAddress)
      .forEach(({ input: { params: [registryId] }, output: { addr } }) => registriesMapping[getRegistryType(registryId)] = addr)
  }
  const poolList = {}
  await Promise.all(Object.entries(registriesMapping).map(async ([registry, addr]) => {
    poolList[registry] = await getPool({ chain, block, registry: addr })
  }))

  return poolList
}

function aggregateBalanceCalls({ coins, nCoins, wrapped }) {
  const toa = []
  coins.map(({ input, output }, i) => {
    const owner = input.params[0]
    toa.push([nullAddress, owner])
    const addToken = t => {
      if (t.toLowerCase() === wrapped.toLowerCase())
        toa.push([nullAddress, owner])
      toa.push([t, owner])
    }
    if (!Object.keys(nCoins).length)
      output.forEach(token => addToken(token))
    else
      for (let index = 0; index < nCoins[i].output[0]; index++)
        addToken(output[index])
  })
  return toa;
}

async function fixWrappedTokenBalances(balances, block, chain, transform) {
  if ("yearnTokens" in contracts[chain]) {
    for (let token of Object.values(contracts[chain].yearnTokens)) {
      if (token in balances) {
        await unwrapYearn(balances, token, block, chain, transform);
      }
    }
  }

  if ("creamTokens" in contracts[chain]) {
    const creamTokens = Object.values(contracts[chain].creamTokens);
    await unwrapCreamTokens(balances, block, chain, creamTokens, transform);
  }

  if ("sdTokens" in contracts[chain]) {
    await unwrapSdTokens(balances, contracts[chain].sdTokens, chain);
  }

  const stDOT = "moonbeam:0xfa36fe1da08c89ec72ea1f0143a35bfd5daea108";
  if (stDOT in balances) {
    balances["bsc:0x7083609fce4d1d8dc0c979aab8c869ea2c873402"] = BigNumber(
      balances[stDOT]
    )
      .times(1e8)
      .toFixed(0);
    delete balances[stDOT];
  }
}

async function unwrapCreamTokens(
  balances,
  block,
  chain,
  creamTokens,
  transform
) {
  const [exchangeRates, underlyingTokens] = await Promise.all([
    sdk.api.abi.multiCall({
      calls: creamTokens.map(t => ({
        target: t
      })),
      abi: creamAbi.exchangeRateStored,
      block,
      chain
    }),
    sdk.api.abi.multiCall({
      calls: creamTokens.map(t => ({
        target: t
      })),
      abi: creamAbi.underlying,
      block,
      chain
    })
  ]);
  for (let i = 0; i < creamTokens.length; i++) {
    if (!(creamTokens[i] in balances)) continue;
    const underlying = underlyingTokens.output[i].output;
    const balance = BigNumber(balances[creamTokens[i]])
      .times(exchangeRates.output[i].output)
      .div(1e18)
      .toFixed(0);
    sdk.util.sumSingleBalance(balances, transform(underlying), balance);
    delete balances[creamTokens[i]];
    delete balances[`${chain}:${creamTokens[i]}`];
  }
}

function mapGaugeTokenBalances(calls, chain) {
  const mapping = {
    // token listed in coins() mapped to gauge token held in contract
    //"0xe7a24ef0c5e95ffb0f6684b813a78f2a3ad7d171": "0x19793b454d3afc7b454f206ffe95ade26ca6912c", // maybe not? 4 0s poly
    "0x7f90122bf0700f9e7e1f688fe926940e8839f353": {
      to: "0xbf7e49483881c76487b0989cd7d9a8239b20ca41",
      pools: [],
      chains: []
    }, // need a pool conditional - only for (1) ['0x30dF229cefa463e991e29D42DB0bae2e122B2AC7']
    "0x1337bedc9d22ecbe766df105c9623922a27963ec": {
      to: "0x5b5cfe992adac0c9d48e05854b2d91c73a003858",
      pools: [],
      chains: ["avax"]
    },
    "0x27e611fd27b276acbd5ffd632e5eaebec9761e40": {
      to: "0x8866414733F22295b7563f9C5299715D2D76CAf4",
      pools: [],
      chains: ["fantom"]
    },
    "0xd02a30d33153877bc20e5721ee53dedee0422b2f": {
      to: "0xd4f94d0aaa640bbb72b5eec2d85f6d114d81a88e",
      pools: [],
      chains: ["fantom"]
    }
  };

  return calls.map(function (c) {
    let target = c.target.toLowerCase();
    if (mapping[target] &&
      (mapping[target].pools.includes(
        c.params[0].toLowerCase()
      ) ||
        mapping[target].chains.includes(chain))
    ) {
      target = mapping[c.target.toLowerCase()].to;
    }
    return { target, params: c.params };
  });
}

async function unwrapSdTokens(balances, sdTokens, chain) {
  const apiData = (await get("https://lockers.stakedao.org/api/lockers")
  ).map(t => ({
    address: t.tokenReceipt.address.toLowerCase(),
    usdPrice: t.tokenPriceUSD,
    decimals: t.tokenReceipt.decimals
  }));

  for (let token of Object.values(sdTokens)) {
    if (token in balances) {
      const tokenInfo = apiData.filter(t => t.address == token)[0];

      sdk.util.sumSingleBalance(
        balances,
        "usd-coin",
        balances[token] * tokenInfo.usdPrice / 10 ** tokenInfo.decimals
      );
      delete balances[token];
      delete balances[`${chain}:{token}`];
    }
  }
} 

async function handleUnlistedFxTokens(balances, chain) {
  if ("fxTokens" in contracts[chain]) {
    const tokens = Object.values(contracts[chain].fxTokens);
    for (let token of tokens) {
      if (token.address in balances) {
        const [rate, { output: decimals }] = await Promise.all([
          get(`https://api.exchangerate.host/convert?from=${token.currency}&to=USD`),
          sdk.api.erc20.decimals(token.address, chain)
        ]);

        sdk.util.sumSingleBalance(
          balances,
          "usd-coin",
          balances[token.address] * rate.result / 10 ** decimals
        );
        delete balances[token.address];
        delete balances[`${chain}:${token.address}`];
      }
    }
  }
  return;
}

async function unwrapPools({ balances, transform, poolList, registry, chain, block }) {
  if (!poolList.length) return;
  const registryAddress = poolList[0].input.target

  const callParams = { target: registryAddress, calls: poolList.map(i => ({ params: i.output })), chain, block, }
  const { output: coins } = await sdk.api.abi.multiCall({ ...callParams, abi: abi.get_coins[registry] })
  let nCoins = {}
  if (registry !== 'cryptoFactory')
    nCoins = (await sdk.api.abi.multiCall({ ...callParams, abi: abi.get_n_coins[registry] })).output

  let { wrapped = '', metapoolBases = {}, blacklist = [] } = contracts[chain]
  wrapped = wrapped.toLowerCase()
  let calls = aggregateBalanceCalls({ coins, nCoins, wrapped });
  return sumTokens2({ balances, chain, block, tokensAndOwners: calls, transformAddress: transform, blacklistedTokens: [...blacklist, ...(Object.values(metapoolBases))] })
}

function tvl(chain) {
  return async (_t, _e, { [chain]: block }) => {
    let balances = {};
    const transform = await getChainTransform(chain);
    const poolLists = await getPools(block, chain);
    const promises = []

    for (const [registry, poolList] of Object.entries(poolLists))
      promises.push(unwrapPools({ balances, transform, poolList, registry, chain, block }))

    await Promise.all(promises)
    await handleUnlistedFxTokens(balances, chain);
    return balances;
  };
}

const chainTypeExports = chains => {
  let exports = chains.reduce(
    (obj, chain) => ({ ...obj, [chain]: { tvl: tvl(chain) } }),
    {}
  );
  exports.ethereum["staking"] = staking(
    contracts.ethereum.veCRV,
    contracts.ethereum.CRV
  );

  exports.harmony = {
    tvl: async (ts, ethB, chainB) => {
      if (ts > 1655989200) {
        // harmony hack
        return {};
      }
      const block = chainB.harmony
      const balances = {};
      await sumTokensSharedOwners(
        balances,
        [
          "0xef977d2f931c1978db5f6747666fa1eacb0d0339",
          "0x3c2b8be99c50593081eaa2a724f0b8285f5aba8f"
        ],
        ["0xC5cfaDA84E902aD92DD40194f0883ad49639b023"],
        block,
        "harmony",
        addr => `harmony:${addr}`
      );
      return balances;
    }
  };
  exports.kava = {
    tvl: async (ts, ethB, chainB) => {
      const block = chainB.kava;
      const balances = {};
      await sumTokensSharedOwners(
        balances,
        [
          "0x765277EebeCA2e31912C9946eAe1021199B39C61",
          "0xB44a9B6905aF7c801311e8F4E76932ee959c663C",
          "0xfA9343C3897324496A05fC75abeD6bAC29f8A40f"
        ],
        ["0x7A0e3b70b1dB0D6CA63Cac240895b2D21444A7b9"],
        block,
        "kava",
        addr => `kava:${addr}`
      );
      return balances;
    }
  };
  exports.hallmarks = [
    [1597446675, "CRV Launch"],
    [1621213201, "Convex Launch"],
    [1642374675, "MIM depeg"],
    [1651881600, "UST depeg"],
    [1654822801, "stETH depeg"]
  ];
  return exports;
};

module.exports = chainTypeExports(chains);
