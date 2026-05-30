# Copy MISA templates from parent EXE2 folder if missing
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$tpl = Join-Path $RepoRoot "converter\fixtures\templates"
$parent = Split-Path $RepoRoot -Parent
New-Item -ItemType Directory -Force -Path $tpl | Out-Null

$map = @{
    "BSN - Form import bán hàng.xls" = "bsn_sales.xls"
    "BSN - Form import mua hàng.xls" = "bsn_purchase.xls"
    "Form bán hàng hóa.xls" = "sales_goods.xls"
    "Form bán hàng dịch vụ.xls" = "sales_service.xls"
    "Form mua hàng hóa.xls" = "purchase_goods.xls"
    "Form mua dịch vụ.xls" = "purchase_service.xls"
}

foreach ($srcName in $map.Keys) {
    $src = Join-Path $parent $srcName
    $dest = Join-Path $tpl $map[$srcName]
    if ((Test-Path $src) -and -not (Test-Path $dest)) {
        Copy-Item $src $dest
        Write-Host "Copied $($map[$srcName])"
    }
}

$samplesSrc = Join-Path $parent "backend\fixtures\samples"
$samplesDest = Join-Path $RepoRoot "converter\fixtures\samples"
if ((Test-Path $samplesSrc) -and -not (Test-Path $samplesDest)) {
    Copy-Item $samplesSrc $samplesDest -Recurse
    Write-Host "Copied fixtures/samples"
}

Write-Host "Setup fixtures done."
