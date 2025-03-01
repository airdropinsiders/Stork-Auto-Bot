import AmazonCognitoIdentity from 'amazon-cognito-identity-js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { accounts } from "./accounts.js"
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// global.navigator = { userAgent: 'node' };

// Load configuration from config.json
function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.json');

    if (!fs.existsSync(configPath)) {
      log(`Config file not found at ${configPath}, using default configuration`, 'WARN');
      // Create default config file if it doesn't exist
      const defaultConfig = {
        cognito: {
          region: 'ap-northeast-1',
          clientId: '5msns4n49hmg3dftp2tp1t2iuh',
          userPoolId: 'ap-northeast-1_M22I44OpC',
          username: '',  // To be filled by user
          password: ''   // To be filled by user
        },
        stork: {
          intervalSeconds: 10
        },
        threads: {
          maxWorkers: 10
        }
      };
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
      return defaultConfig;
    }
    
    const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    log('Configuration loaded successfully from config.json \n');
    log('Accounts loaded successfully from accounts.js');
    return userConfig;
  } catch (error) {
    log(`Error loading config: ${error.message}`, 'ERROR');
    throw new Error('Failed to load configuration');
  }
}

const userConfig = loadConfig();
const config = {
  cognito: {
    region: userConfig.cognito?.region || 'ap-northeast-1',
    clientId: userConfig.cognito?.clientId || '5msns4n49hmg3dftp2tp1t2iuh',
    userPoolId: userConfig.cognito?.userPoolId || 'ap-northeast-1_M22I44OpC',
    username: userConfig.cognito?.username || '',
    password: userConfig.cognito?.password || ''
  },
  stork: {
    baseURL: 'https://app-api.jp.stork-oracle.network/v1',
    authURL: 'https://api.jp.stork-oracle.network/auth',
    tokenPath: path.join(__dirname, 'tokens.json'),
    intervalSeconds: userConfig.stork?.intervalSeconds || 10,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    origin: 'chrome-extension://knnliglhgkmlblppdejchidfihjnockl'
  },
  threads: {
    maxWorkers: userConfig.threads?.maxWorkers || 10,
    proxyFile: path.join(__dirname, 'proxies.txt')
  }
};

function validateConfig() {
  if (!accounts[0].username || !accounts[0].password) {
    log('ERROR: Username and password must be set in accounts.js', 'ERROR');
    console.log('\nPlease update your accouns.js file with your credentials:');
    console.log(JSON.stringify({
        username: "YOUR_EMAIL",
        password: "YOUR_PASSWORD"
    }, null, 2));
    return false;
  }
  return true;
}

const poolData = { UserPoolId: config.cognito.userPoolId, ClientId: config.cognito.clientId };
const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);

function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substr(0, 19);
}

function getFormattedDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

function log(message, type = 'INFO') {
  console.log(`[${getFormattedDate()}] [${type}] ${message}`);
}

function loadProxies() {
  try {
    if (!fs.existsSync(config.threads.proxyFile)) {
      log(`Proxy file not found at ${config.threads.proxyFile}, creating empty file`, 'WARN');
      fs.writeFileSync(config.threads.proxyFile, '', 'utf8');
      return [];
    }
    const proxyData = fs.readFileSync(config.threads.proxyFile, 'utf8');
    const proxies = proxyData
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    log(`Loaded ${proxies.length} proxies from ${config.threads.proxyFile}`);
    return proxies;
  } catch (error) {
    log(`Error loading proxies: ${error.message}`, 'ERROR');
    return [];
  }
}

class CognitoAuth {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.authenticationDetails = new AmazonCognitoIdentity.AuthenticationDetails({ Username: username, Password: password });
    this.cognitoUser = new AmazonCognitoIdentity.CognitoUser({ Username: username, Pool: userPool });
  }

  authenticate() {
    return new Promise((resolve, reject) => {
      this.cognitoUser.authenticateUser(this.authenticationDetails, {
        onSuccess: (result) => resolve({
          accessToken: result.getAccessToken().getJwtToken(),
          idToken: result.getIdToken().getJwtToken(),
          refreshToken: result.getRefreshToken().getToken(),
          expiresIn: result.getAccessToken().getExpiration() * 1000 - Date.now()
        }),
        onFailure: (err) => reject(err),
        newPasswordRequired: () => reject(new Error('New password required'))
      });
    });
  }

  refreshSession(refreshToken) {
    const refreshTokenObj = new AmazonCognitoIdentity.CognitoRefreshToken({ RefreshToken: refreshToken });
    return new Promise((resolve, reject) => {
      this.cognitoUser.refreshSession(refreshTokenObj, (err, result) => {
        if (err) reject(err);
        else resolve({
          accessToken: result.getAccessToken().getJwtToken(),
          idToken: result.getIdToken().getJwtToken(),
          refreshToken: refreshToken,
          expiresIn: result.getAccessToken().getExpiration() * 1000 - Date.now()
        });
      });
    });
  }
}

class TokenManager {
  constructor(i) {
    this.accessToken = null;
    this.refreshToken = null;
    this.idToken = null;
    this.expiresAt = null;
    this.auth = new CognitoAuth(accounts[i].username, accounts[i].password);
  }

  async getValidToken() {
    if (!this.accessToken || this.isTokenExpired()) await this.refreshOrAuthenticate();
    return this.accessToken;
  }

  isTokenExpired() {
    return Date.now() >= this.expiresAt;
  }

  async refreshOrAuthenticate() {
    try {
      let result = this.refreshToken ? await this.auth.refreshSession(this.refreshToken) : await this.auth.authenticate();
      await this.updateTokens(result);
    } catch (error) {
      log(`Token refresh/auth error: ${error.message}`, 'ERROR');
      throw error;
    }
  }

  async updateTokens(result) {
    this.accessToken = result.accessToken;
    this.idToken = result.idToken;
    this.refreshToken = result.refreshToken;
    this.expiresAt = Date.now() + result.expiresIn;
    const tokens = { accessToken: this.accessToken, idToken: this.idToken, refreshToken: this.refreshToken, isAuthenticated: true, isVerifying: false };
    await saveTokens(tokens);
    log('Tokens updated and saved to tokens.json');
  }
}

async function getTokens() {
  try {
    if (!fs.existsSync(config.stork.tokenPath)) throw new Error(`Tokens file not found at ${config.stork.tokenPath}`);
    const tokensData = await fs.promises.readFile(config.stork.tokenPath, 'utf8');
    const tokens = JSON.parse(tokensData);
    if (!tokens.accessToken || tokens.accessToken.length < 20) throw new Error('Invalid access token');
    log(`Successfully read access token: ${tokens.accessToken.substring(0, 10)}...`);
    return tokens;
  } catch (error) {
    log(`Error reading tokens: ${error.message}`, 'ERROR');
    throw error;
  }
}

async function saveTokens(tokens) {
  try {
    await fs.promises.writeFile(config.stork.tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
    log('Tokens saved successfully');
    return true;
  } catch (error) {
    log(`Error saving tokens: ${error.message}`, 'ERROR');
    return false;
  }
}

function getProxyAgent(proxy) {
  if (!proxy) return null;
  if (proxy.startsWith('http')) return new HttpsProxyAgent(proxy);
  if (proxy.startsWith('socks4') || proxy.startsWith('socks5')) return new SocksProxyAgent(proxy);
  throw new Error(`Unsupported proxy protocol: ${proxy}`);
}

async function refreshTokens(refreshToken) {
  try {
    log('Refreshing access token via Stork API...');
    const response = await axios({
      method: 'POST',
      url: `${config.stork.authURL}/refresh`,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': config.stork.userAgent,
        'Origin': config.stork.origin
      },
      data: { refresh_token: refreshToken }
    });
    const tokens = {
      accessToken: response.data.access_token,
      idToken: response.data.id_token || '',
      refreshToken: response.data.refresh_token || refreshToken,
      isAuthenticated: true,
      isVerifying: false
    };
    await saveTokens(tokens);
    log('Token refreshed successfully via Stork API');
    return tokens;
  } catch (error) {
    log(`Token refresh failed: ${error.message}`, 'ERROR');
    throw error;
  }
}

async function getSignedPrices(tokens) {
  try {
    log('Fetching signed prices data...');
    const response = await axios({
      method: 'GET',
      url: `${config.stork.baseURL}/stork_signed_prices`,
      headers: {
        'Authorization': `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
        'Origin': config.stork.origin,
        'User-Agent': config.stork.userAgent
      }
    });
    const dataObj = response.data.data;
    const result = Object.keys(dataObj).map(assetKey => {
      const assetData = dataObj[assetKey];
      return {
        asset: assetKey,
        msg_hash: assetData.timestamped_signature.msg_hash,
        price: assetData.price,
        timestamp: new Date(assetData.timestamped_signature.timestamp / 1000000).toISOString(),
        ...assetData
      };
    });
    log(`Successfully retrieved ${result.length} signed prices`);
    return result;
  } catch (error) {
    log(`Error getting signed prices: ${error.message}`, 'ERROR');
    throw error;
  }
}

async function sendValidation(tokens, msgHash, isValid, proxy) {
  try {
    const agent = getProxyAgent(proxy);
    const response = await axios({
      method: 'POST',
      url: `${config.stork.baseURL}/stork_signed_prices/validations`,
      headers: {
        'Authorization': `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
        'Origin': config.stork.origin,
        'User-Agent': config.stork.userAgent
      },
      httpsAgent: agent,
      data: { msg_hash: msgHash, valid: isValid }
    });
    log(`✓ Validation successful for ${msgHash.substring(0, 10)}... via ${proxy || 'direct'}`);
    return response.data;
  } catch (error) {
    log(`✗ Validation failed for ${msgHash.substring(0, 10)}...: ${error.message}`, 'ERROR');
    throw error;
  }
}

async function getUserStats(tokens) {
  try {
    log('Fetching user stats...');
    const response = await axios({
      method: 'GET',
      url: `${config.stork.baseURL}/me`,
      headers: {
        'Authorization': `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
        'Origin': config.stork.origin,
        'User-Agent': config.stork.userAgent
      }
    });
    return response.data.data;
  } catch (error) {
    log(`Error getting user stats: ${error.message}`, 'ERROR');
    throw error;
  }
}

function validatePrice(priceData) {
  try {
    log(`Validating data for ${priceData.asset || 'unknown asset'}`);
    if (!priceData.msg_hash || !priceData.price || !priceData.timestamp) {
      log('Incomplete data, considered invalid', 'WARN');
      return false;
    }
    const currentTime = Date.now();
    const dataTime = new Date(priceData.timestamp).getTime();
    const timeDiffMinutes = (currentTime - dataTime) / (1000 * 60);
    if (timeDiffMinutes > 60) {
      log(`Data too old (${Math.round(timeDiffMinutes)} minutes ago)`, 'WARN');
      return false;
    }
    return true;
  } catch (error) {
    log(`Validation error: ${error.message}`, 'ERROR');
    return false;
  }
}

if (!isMainThread) {
  const { priceData, tokens, proxy } = workerData;

  async function validateAndSend() {
    try {
      const isValid = validatePrice(priceData);
      await sendValidation(tokens, priceData.msg_hash, isValid, proxy);
      parentPort.postMessage({ success: true, msgHash: priceData.msg_hash, isValid });
    } catch (error) {
      parentPort.postMessage({ success: false, error: error.message, msgHash: priceData.msg_hash });
    }
  }

  validateAndSend();
} else {
  let previousStats = { validCount: 0, invalidCount: 0 };

  async function runValidationProcess(tokenManager) {
    try {
      log('--------- STARTING VALIDATION PROCESS ---------');
      const tokens = await getTokens();
      const initialUserData = await getUserStats(tokens);

      if (!initialUserData || !initialUserData.stats) {
        throw new Error('Could not fetch initial user stats');
      }

      const initialValidCount = initialUserData.stats.stork_signed_prices_valid_count || 0;
      const initialInvalidCount = initialUserData.stats.stork_signed_prices_invalid_count || 0;

      if (previousStats.validCount === 0 && previousStats.invalidCount === 0) {
        previousStats.validCount = initialValidCount;
        previousStats.invalidCount = initialInvalidCount;
      }

      const signedPrices = await getSignedPrices(tokens);
      const proxies = loadProxies();

      if (!signedPrices || signedPrices.length === 0) {
        log('No data to validate');
        const userData = await getUserStats(tokens);
        displayStats(userData);
        return;
      }

      log(`Processing ${signedPrices.length} data points with ${config.threads.maxWorkers} workers...`);
      const workers = [];

      const chunkSize = Math.ceil(signedPrices.length / config.threads.maxWorkers);
      const batches = [];
      for (let i = 0; i < signedPrices.length; i += chunkSize) {
        batches.push(signedPrices.slice(i, i + chunkSize));
      }

      for (let i = 0; i < Math.min(batches.length, config.threads.maxWorkers); i++) {
        const batch = batches[i];
        const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;

        batch.forEach(priceData => {
          workers.push(new Promise((resolve) => {
            const worker = new Worker(__filename, {
              workerData: { priceData, tokens, proxy }
            });
            worker.on('message', resolve);
            worker.on('error', (error) => resolve({ success: false, error: error.message }));
            worker.on('exit', () => resolve({ success: false, error: 'Worker exited' }));
          }));
        });
      }

      const results = await Promise.all(workers);
      const successCount = results.filter(r => r.success).length;
      log(`Processed ${successCount}/${results.length} validations successfully`);

      const updatedUserData = await getUserStats(tokens);
      const newValidCount = updatedUserData.stats.stork_signed_prices_valid_count || 0;
      const newInvalidCount = updatedUserData.stats.stork_signed_prices_invalid_count || 0;

      const actualValidIncrease = newValidCount - previousStats.validCount;
      const actualInvalidIncrease = newInvalidCount - previousStats.invalidCount;

      previousStats.validCount = newValidCount;
      previousStats.invalidCount = newInvalidCount;

      displayStats(updatedUserData);
      log(`--------- VALIDATION SUMMARY ---------`);
      log(`Total data processed: ${actualValidIncrease + actualInvalidIncrease}`);
      log(`Successful: ${actualValidIncrease}`);
      log(`Failed: ${actualInvalidIncrease}`);
      log('--------- COMPLETE ---------');
      
      if(jobs < accounts.length) {
        console.info(jobs);
        main();
      }
    } catch (error) {
      log(`Validation process stopped: ${error.message}`, 'ERROR');
    }
  }

  function displayStats(userData) {
    if (!userData || !userData.stats) {
      log('No valid stats data available to display', 'WARN');
      return;
    }

    console.clear();
    console.log('=============================================');
    console.log('   STORK ORACLE AUTO BOT - AIRDROP INSIDERS  ');
    console.log('=============================================');
    console.log(`Time: ${getTimestamp()}`);
    console.log('---------------------------------------------');
    console.log(`User: ${userData.email || 'N/A'}`);
    console.log(`ID: ${userData.id || 'N/A'}`);
    console.log(`Referral Code: ${userData.referral_code || 'N/A'}`);
    console.log('---------------------------------------------');
    console.log('VALIDATION STATISTICS:');
    console.log(`✓ Valid Validations: ${userData.stats.stork_signed_prices_valid_count || 0}`);
    console.log(`✗ Invalid Validations: ${userData.stats.stork_signed_prices_invalid_count || 0}`);
    console.log(`↻ Last Validated At: ${userData.stats.stork_signed_prices_last_verified_at || 'Never'}`);
    console.log(`👥 Referral Usage Count: ${userData.stats.referral_usage_count || 0}`);
    console.log('---------------------------------------------');
    console.log(`Next validation in ${config.stork.intervalSeconds} seconds...`);
    console.log('=============================================');
  }

  async function main() {
    if (!validateConfig()) {
      process.exit(1);
    }
    
    log(`processing ${accounts[jobs].username}`);
    const tokenManager = new TokenManager(jobs);
    jobs++;

    try {
      await tokenManager.getValidToken();
      log('Initial authentication successful');

      runValidationProcess(tokenManager);
      setInterval(() => runValidationProcess(tokenManager), config.stork.intervalSeconds * 1000);
      setInterval(async () => {
        await tokenManager.getValidToken();
        log('Token refreshed via Cognito');
      }, 50 * 60 * 1000);
    } catch (error) {
      log(`Application failed to start: ${error.message}`, 'ERROR');
   //   process.exit(1);
    }
  }
  
  let jobs = 0;
  main();
}