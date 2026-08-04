module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts?(x)', '**/?(*.)+(spec|test).ts?(x)'],
  collectCoverageFrom: ['lib/**/*.ts', 'lib/**/*.tsx', '!lib/**/*.d.ts'],
  testPathIgnorePatterns: ['<rootDir>/lib/server/', '<rootDir>/app/api/'],
};
