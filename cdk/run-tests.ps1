$env:CI = "true"
$env:FORCE_COLOR = "0"
Set-Location "c:\Users\jkalir01\Documents\deployments\LAIGO\cdk"
node ./node_modules/jest/bin/jest.js --testPathPattern security-hardening --no-coverage --forceExit --ci 2>&1 | Out-File -FilePath "c:\Users\jkalir01\Documents\deployments\LAIGO\cdk\test-output.txt" -Encoding utf8
