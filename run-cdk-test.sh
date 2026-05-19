#!/bin/bash
cd /mnt/c/Users/jkalir01/Documents/deployments/LAIGO/cdk
node node_modules/typescript/bin/tsc > /tmp/cdk-test-output.txt 2>&1
echo "TSC_EXIT=$?" >> /tmp/cdk-test-output.txt
node -e "const jest = require('jest-cli'); jest.run(['--testPathPattern=security-hardening', '--no-coverage', '--forceExit'])" >> /tmp/cdk-test-output.txt 2>&1
echo "JEST_EXIT=$?" >> /tmp/cdk-test-output.txt
cat /tmp/cdk-test-output.txt
