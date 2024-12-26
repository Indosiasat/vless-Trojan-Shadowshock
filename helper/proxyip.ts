import { appendFileSync } from "node:fs";

interface ProxyStruct {
  address: string;
  port: number;
  country: string;
  org: string;
}

interface ProxyTestResult {
  error: boolean;
  message?: string;
  result?: {
    proxy: string;
    proxyip: boolean;
    ip: string;
    port: number;
    delay: number;
    country: string;
    asOrganization: string;
  };
}

const KV_PAIR_PROXY_FILE = "./kvProxyList.json";
const RAW_PROXY_LIST_FILE = "./rawProxyList.txt";
const PROXY_LIST_FILE = "./proxyList.txt";
const IP_RESOLVER_DOMAIN = "https://id1.foolvpn.me/api/v1/check";
const CONCURRENCY = 99;

const CHECK_QUEUE: string[] = [];

async function readProxyList(): Promise<ProxyStruct[]> {
  const proxyList: ProxyStruct[] = [];
  const fileContent = await Bun.file(RAW_PROXY_LIST_FILE).text();
  const proxyListString = fileContent.split("\n").filter((line) => line.trim() !== ""); // Filter baris kosong

  if (proxyListString.length === 0) {
    throw new Error(`File ${RAW_PROXY_LIST_FILE} kosong atau tidak valid.`);
  }

  for (const proxy of proxyListString) {
    const [address, port, country, org] = proxy.split(",");
    if (!address || !port || isNaN(parseInt(port))) {
      console.warn(`Baris tidak valid di file proxy list: ${proxy}`);
      continue;
    }
    proxyList.push({
      address,
      port: parseInt(port),
      country: country || "Unknown Country",
      org: org || "No Organization",
    });
  }

  return proxyList;
}

async function checkProxy(proxyAddress: string, proxyPort: number): Promise<ProxyTestResult> {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5000);

  try {
    const res = await Bun.fetch(IP_RESOLVER_DOMAIN + `?ip=${proxyAddress}:${proxyPort}`, {
      signal: controller.signal,
    });

    if (res.status === 200) {
      return {
        error: false,
        result: await res.json(),
      };
    } else {
      throw new Error(res.statusText);
    }
  } catch (e: any) {
    return {
      error: true,
      message: e.message,
    };
  }
}

(async () => {
  try {
    const start = new Date().getTime();
    const proxyList = await readProxyList();
    const proxyChecked: Set<string> = new Set();
    const uniqueRawProxies: string[] = [];
    const activeProxyList: string[] = [];
    const kvPair: Record<string, string[]> = {};
    let savedProxiesCount = 0;

    for (const proxy of proxyList) {
      const proxyKey = `${proxy.address}:${proxy.port}`;
      if (proxyChecked.has(proxyKey)) continue;

      proxyChecked.add(proxyKey);
      uniqueRawProxies.push(
        `${proxy.address},${proxy.port},${proxy.country},${proxy.org.replace(/[+]/g, " ")}`
      );

      CHECK_QUEUE.push(proxyKey);
      checkProxy(proxy.address, proxy.port)
        .then((res) => {
          if (!res.error && res.result && res.result.proxyip === true && res.result.country) {
            activeProxyList.push(
              `${res.result.proxy},${res.result.port},${res.result.country},${res.result.asOrganization || "No Organization"}`
            );

            if (!kvPair[res.result.country]) kvPair[res.result.country] = [];
            if (kvPair[res.result.country].length < 10) {
              kvPair[res.result.country].push(`${res.result.proxy}:${res.result.port}`);
            }

            savedProxiesCount += 1;
            console.log(`[${CHECK_QUEUE.length}] Proxy disimpan:`, savedProxiesCount);
          }
        })
        .finally(() => {
          const index = CHECK_QUEUE.indexOf(proxyKey);
          if (index !== -1) CHECK_QUEUE.splice(index, 1);
        });

      while (CHECK_QUEUE.length >= CONCURRENCY) {
        await Bun.sleep(10);
      }
    }

    // Tunggu proses selesai
    while (CHECK_QUEUE.length > 0) {
      await Bun.sleep(100);
    }

    // Menulis file hanya jika data valid
    if (Object.keys(kvPair).length > 0) {
      await Bun.write(KV_PAIR_PROXY_FILE, JSON.stringify(kvPair, null, 2));
    }
    if (uniqueRawProxies.length > 0) {
      await Bun.write(RAW_PROXY_LIST_FILE, uniqueRawProxies.join("\n"));
    }
    if (activeProxyList.length > 0) {
      await Bun.write(PROXY_LIST_FILE, activeProxyList.join("\n"));
    }

    const finish = new Date().getTime();
    console.log(`Waktu proses: ${((finish - start) / 1000).toFixed(2)} detik`);
  } catch (error) {
    console.error("Terjadi kesalahan:", error);
  }
})();
