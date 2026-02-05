import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  // Database configuration
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'openfederation_pds',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },

  // PDS configuration
  pds: {
    hostname: process.env.PDS_HOSTNAME || 'pds.openfederation.net',
    serviceUrl: process.env.PDS_SERVICE_URL || 'https://pds.openfederation.net',
  },

  // PLC directory
  plc: {
    directoryUrl: process.env.PLC_DIRECTORY_URL || 'https://plc.directory',
  },

  // Handle suffix for did:plc communities
  handleSuffix: process.env.HANDLE_SUFFIX || '.openfederation.net',
};
