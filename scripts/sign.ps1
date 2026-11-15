param(
  [Parameter(Mandatory = $true)][string]$File,
  [string]$Subject = "CN=oh-my-coding-pi self-signed",
  [switch]$TrustLocal
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $File)) { throw "文件不存在：$File" }

# 1) 找或创建自签名代码签名证书（当前用户，3 年有效）
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -eq $Subject } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if (-not $cert) {
  Write-Host "创建自签名证书：$Subject"
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -KeyUsage DigitalSignature `
    -NotAfter (Get-Date).AddYears(3)
}
Write-Host ("证书：{0}（{1} – {2}）" -f $cert.Thumbprint, $cert.NotBefore.ToString("yyyy-MM-dd"), $cert.NotAfter.ToString("yyyy-MM-dd"))

# 2) 签名（先带时间戳，失败则退化到不带时间戳）
try {
  $result = Set-AuthenticodeSignature -FilePath $File -Certificate $cert `
    -HashAlgorithm SHA256 -TimestampServer "http://timestamp.digicert.com"
  # 自签名证书的 Status 会是 UnknownError（根不受信任），只要签名者存在就算签上了
  if (-not $result.SignerCertificate) { throw "没有产生签名者证书" }
} catch {
  Write-Warning "带时间戳签名失败（$($_.Exception.Message)），改为不带时间戳"
  $result = Set-AuthenticodeSignature -FilePath $File -Certificate $cert -HashAlgorithm SHA256
  if (-not $result.SignerCertificate) { throw "签名失败：$($result.StatusMessage)" }
}

$check = Get-AuthenticodeSignature -FilePath $File
Write-Host ("签名状态：{0}" -f $check.Status)
Write-Host ("签名者：{0}" -f $check.SignerCertificate.Subject)
if ($check.Status -ne "Valid") {
  Write-Host "说明：自签名证书不在受信任根里，资源管理器仍会提示“未知发布者”；"
  Write-Host "      用 -TrustLocal 把证书装进当前用户的“受信任的根证书颁发机构”后，本机才会显示为已验证。"
}

# 3) 可选：装到当前用户受信任根（只影响本机）
if ($TrustLocal) {
  $tmp = Join-Path $env:TEMP ("omcp-signer-{0}.cer" -f $cert.Thumbprint)
  Export-Certificate -Cert $cert -FilePath $tmp | Out-Null
  Import-Certificate -FilePath $tmp -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
  Remove-Item $tmp -Force
  $again = Get-AuthenticodeSignature -FilePath $File
  Write-Host ("装信任后的状态：{0}" -f $again.Status)
}

Write-Host ("SIGNED=" + $File)
Write-Host ("SIGN_STATUS=" + (Get-AuthenticodeSignature -FilePath $File).Status)
Write-Host ("CERT_THUMBPRINT=" + $cert.Thumbprint)
