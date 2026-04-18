const { ConfidentialClientApplication } = require('@azure/msal-node')
const { Client } = require('@microsoft/microsoft-graph-client')

const GRAPH_SCOPES = ['https://graph.microsoft.com/.default']

let msalClientInstance = null
let graphClientInstance = null

function getMsalClient() {
  if (msalClientInstance) return msalClientInstance

  const { MICROSOFT_CLIENT_ID, MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_SECRET } = process.env
  if (!MICROSOFT_CLIENT_ID || !MICROSOFT_TENANT_ID || !MICROSOFT_CLIENT_SECRET) {
    throw new Error(
      'Variables d\'environnement Microsoft manquantes (MICROSOFT_CLIENT_ID, MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_SECRET)'
    )
  }

  msalClientInstance = new ConfidentialClientApplication({
    auth: {
      clientId: MICROSOFT_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}`,
      clientSecret: MICROSOFT_CLIENT_SECRET,
      knownAuthorities: ['login.microsoftonline.com'],
    },
  })
  return msalClientInstance
}

async function getAccessToken() {
  const msal = getMsalClient()
  const response = await msal.acquireTokenByClientCredential({ scopes: GRAPH_SCOPES })
  if (!response || !response.accessToken) {
    throw new Error('Aucun token d\'accès reçu de MSAL')
  }
  return response.accessToken
}

function getGraphClient() {
  if (graphClientInstance) return graphClientInstance
  graphClientInstance = Client.init({
    authProvider: async (done) => {
      try {
        const token = await getAccessToken()
        done(null, token)
      } catch (err) {
        done(err, null)
      }
    },
  })
  return graphClientInstance
}

function __resetForTests() {
  msalClientInstance = null
  graphClientInstance = null
}

module.exports = { getMsalClient, getAccessToken, getGraphClient, __resetForTests }
