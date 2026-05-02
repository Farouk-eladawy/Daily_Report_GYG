$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigFile = Join-Path $ScriptDir 'config.json'

if (-not (Test-Path $ConfigFile)) {
    throw "Configuration file not found at $ConfigFile"
}

$Config = Get-Content $ConfigFile -Raw | ConvertFrom-Json

$loggingPath = $null
if ($Config.Logging -and ($Config.Logging.PSObject.Properties.Name -contains 'Path')) {
    $loggingPath = $Config.Logging.Path
}
if ([string]::IsNullOrWhiteSpace($loggingPath)) {
    $loggingPath = 'Logs'
}
$LogDir = Join-Path $ScriptDir $loggingPath
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir ("GygSync_{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-Log {
    param(
        [string]$Message,
        [string]$Level = 'INFO'
    )
    $Timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $LogEntry = "[$Timestamp] [$Level] $Message"

    $written = $false
    for ($i = 0; $i -lt 5; $i++) {
        try {
            [System.IO.File]::AppendAllText($LogFile, $LogEntry + [System.Environment]::NewLine, [System.Text.Encoding]::UTF8)
            $written = $true
            break
        } catch {
            Start-Sleep -Milliseconds (200 * ($i + 1))
        }
    }
    if (-not $written) {
        try {
            $fallback = Join-Path $ScriptDir ("GygSync_fallback_{0}.txt" -f (Get-Date -Format 'yyyy-MM-dd'))
            [System.IO.File]::AppendAllText($fallback, $LogEntry + [System.Environment]::NewLine, [System.Text.Encoding]::UTF8)
        } catch {}
    }
    $Color = switch ($Level) {
        'ERROR' { 'Red' }
        'WARN' { 'Yellow' }
        'SUCCESS' { 'Green' }
        default { 'White' }
    }
    Write-Host $LogEntry -ForegroundColor $Color
}

function Invoke-AirtableRequest {
    param(
        [string]$Url,
        [string]$Method = 'GET',
        [hashtable]$Body = $null
    )

    $MaxRetries = 5
    $RetryDelay = 3

    Add-Type -AssemblyName System.Net.Http | Out-Null

    for ($i = 0; $i -lt $MaxRetries; $i++) {
        $client = $null
        try {
            $client = New-Object System.Net.Http.HttpClient
            $client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Config.Airtable.ApiKey)

            $request = New-Object System.Net.Http.HttpRequestMessage
            $request.Method = New-Object System.Net.Http.HttpMethod($Method)
            $request.RequestUri = [Uri]$Url

            if ($Body) {
                $jsonBody = $Body | ConvertTo-Json -Depth 10 -Compress
                $request.Content = New-Object System.Net.Http.StringContent($jsonBody, [System.Text.Encoding]::UTF8, 'application/json')
            }

            $response = $client.SendAsync($request).Result
            $status = [int]$response.StatusCode
            $content = $response.Content.ReadAsStringAsync().Result

            if ($status -ge 200 -and $status -lt 300) {
                if ([string]::IsNullOrWhiteSpace($content)) { return $null }
                try { return ($content | ConvertFrom-Json) } catch { return $content }
            }

            $errorMsg = "HTTP $status"
            if (-not [string]::IsNullOrWhiteSpace($content)) {
                $errorMsg += " | API Response: $content"
            }

            if ($Body -and $status -eq 422) {
                try {
                    $debugPath = Join-Path $ScriptDir ("debug_airtable_422_{0}.json" -f (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'))
                    $Body | ConvertTo-Json -Depth 10 | Out-File -FilePath $debugPath -Encoding utf8
                    Write-Log "Saved Airtable 422 debug payload: $debugPath" 'WARN'
                } catch {}
            }

            throw $errorMsg
        } catch {
            $msg = $_.Exception.Message
            Write-Log "Airtable API warning ($Method): $msg. Retrying in $RetryDelay s..." 'WARN'
            Start-Sleep -Seconds $RetryDelay
            $RetryDelay = [Math]::Min($RetryDelay * 2, 60)
        } finally {
            if ($client) { $client.Dispose() }
        }
    }

    throw "Airtable request failed after $MaxRetries attempts: $Method $Url"
}

function Get-AirtableAllRecords {
    param(
        [string]$TableRef,
        [string[]]$Fields = @()
    )

    $EncodedTableRef = [System.Uri]::EscapeDataString($TableRef)
    $BaseUrl = "https://api.airtable.com/v0/$($Config.Airtable.BaseId)/$EncodedTableRef"
    $Records = @()
    $Offset = $null

    do {
        $Uri = "${BaseUrl}`?pageSize=100"
        if ($Offset) { $Uri += "&offset=$Offset" }
        foreach ($f in $Fields) {
            if (-not [string]::IsNullOrWhiteSpace($f)) {
                $Uri += "&fields[]=$([uri]::EscapeDataString($f))"
            }
        }

        $Response = Invoke-AirtableRequest -Url $Uri -Method 'GET'
        if ($Response.records) { $Records += $Response.records }
        $Offset = $Response.offset
        Start-Sleep -Milliseconds 200
    } while ($Offset)

    return $Records
}

function Test-AirtableTableAccess {
    param(
        [string]$TableRef
    )

    $EncodedTableRef = [System.Uri]::EscapeDataString($TableRef)
    $Url = "https://api.airtable.com/v0/$($Config.Airtable.BaseId)/$EncodedTableRef`?pageSize=1"
    [void](Invoke-AirtableRequest -Url $Url -Method 'GET')
}

function Start-GygScrape {
    $skipScrape = $false
    if (-not [string]::IsNullOrWhiteSpace($env:GYG_SKIP_SCRAPE)) {
        $skipScrape = $env:GYG_SKIP_SCRAPE.Trim().ToLower() -in @('1','true','yes','y','on')
    }
    if ($skipScrape) {
        Write-Log 'Skipping GYG scrape (GYG_SKIP_SCRAPE=true).' 'WARN'
        return
    }

    $NodeScript = Join-Path $ScriptDir 'scrape_gyg.js'
    if (-not (Test-Path $NodeScript)) {
        throw "Node script not found: $NodeScript"
    }

    $Email = $Config.GYG.Email
    $Password = $Config.GYG.Password
    $Secret = $Config.GYG.Secret
    if ([string]::IsNullOrWhiteSpace($Email) -or [string]::IsNullOrWhiteSpace($Password) -or [string]::IsNullOrWhiteSpace($Secret)) {
        throw 'GYG credentials are missing in config.json (GYG.Email / GYG.Password / GYG.Secret)'
    }

    if ([string]::IsNullOrWhiteSpace($env:BROWSER_HEADLESS)) {
        $env:BROWSER_HEADLESS = 'true'
    }

    Write-Log "Running GYG scraper (BROWSER_HEADLESS=$($env:BROWSER_HEADLESS))..." 'INFO'

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'node'
    $psi.Arguments = "`"$NodeScript`" `"$Email`" `"$Password`" `"$Secret`""
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $psi.EnvironmentVariables['BROWSER_HEADLESS'] = $env:BROWSER_HEADLESS
    if (-not [string]::IsNullOrWhiteSpace($env:GYG_MAX_REVIEW_PRODUCTS)) {
        $psi.EnvironmentVariables['GYG_MAX_REVIEW_PRODUCTS'] = $env:GYG_MAX_REVIEW_PRODUCTS
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $process.EnableRaisingEvents = $true

    $outEvent = $null
    $errEvent = $null
    try {
        $outEvent = Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -Action {
            if ($EventArgs.Data) {
                $line = $EventArgs.Data.Trim()
                if ($line) { Write-Log "[GYG] $line" 'INFO' }
            }
        }
        $errEvent = Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -Action {
            if ($EventArgs.Data) {
                $line = $EventArgs.Data.Trim()
                if ($line) { Write-Log "[GYG] $line" 'WARN' }
            }
        }
    } catch {
        Write-Log "Failed to register output events: $($_.Exception.Message)" 'WARN'
    }

    try {
        $process.Start() | Out-Null
    } catch {
        Write-Log "Failed to start node process. Check that Node.js is installed and on PATH. Error: $($_.Exception.Message)" 'ERROR'
        throw
    }
    Write-Log "Node process started (pid=$($process.Id))." 'INFO'
    $process.BeginOutputReadLine() | Out-Null
    $process.BeginErrorReadLine() | Out-Null
    $process.WaitForExit()
    $process.WaitForExit(2000)

    Write-Log "Node process exited (code=$($process.ExitCode))." 'INFO'

    if ($outEvent) {
        $outSubId = $outEvent.SubscriptionId
        if (-not $outSubId) { $outSubId = $outEvent.Id }
        if ($outSubId) { Unregister-Event -SubscriptionId $outSubId -ErrorAction SilentlyContinue }
    }
    if ($errEvent) {
        $errSubId = $errEvent.SubscriptionId
        if (-not $errSubId) { $errSubId = $errEvent.Id }
        if ($errSubId) { Unregister-Event -SubscriptionId $errSubId -ErrorAction SilentlyContinue }
    }

    if ($process.ExitCode -ne 0) {
        throw "GYG scraper failed with exit code $($process.ExitCode)"
    }
}

function Convert-GygJsonToAirtableFields {
    param([pscustomobject]$Row)

    function Parse-IntOrNull([string]$s) {
        if ([string]::IsNullOrWhiteSpace($s)) { return $null }
        $t = $s.Trim()
        if ($t -eq '-' -or $t -eq 'Error' -or $t -eq 'null') { return $null }
        $t = $t -replace ',', ''
        $n = 0
        if ([int]::TryParse($t, [ref]$n)) { return $n }
        $d = 0.0
        if ([double]::TryParse($t, [ref]$d)) { return [int][math]::Truncate($d) }
        return $null
    }

    function Parse-DoubleOrNull([string]$s) {
        if ([string]::IsNullOrWhiteSpace($s)) { return $null }
        $t = $s.Trim()
        if ($t -eq '-' -or $t -eq 'Error' -or $t -eq 'null') { return $null }
        $t = $t -replace ',', ''
        $d = 0.0
        if ([double]::TryParse($t, [ref]$d)) { return $d }
        return $null
    }

    function Parse-PercentToPercentOrNull([string]$s) {
        if ([string]::IsNullOrWhiteSpace($s)) { return $null }
        $t = $s.Trim()
        if ($t -eq '-' -or $t -eq 'Error' -or $t -eq 'null') { return $null }
        $t = $t -replace ',', ''
        $t = $t -replace '%', ''
        $d = 0.0
        if ([double]::TryParse($t, [ref]$d)) { return $d }
        return $null
    }

    function Parse-CurrencyOrNull([string]$s) {
        if ([string]::IsNullOrWhiteSpace($s)) { return $null }
        $t = $s.Trim()
        if ($t -eq '-' -or $t -eq 'Error' -or $t -eq 'null') { return $null }
        $t = $t -replace '[^0-9\.,\-]', ''
        $t = $t -replace ',', ''
        $d = 0.0
        if ([double]::TryParse($t, [ref]$d)) { return $d }
        return $null
    }

    $productId = [string]($Row.productId)
    $productName = [string]($Row.productName)
    $periodReviews = Parse-IntOrNull ([string]$Row.periodReviews)
    if ($periodReviews -eq $null) { $periodReviews = 0 }
    $bookings = Parse-IntOrNull ([string]$Row.bookings)
    if ($bookings -eq $null) { $bookings = 0 }
    $rating = Parse-DoubleOrNull ([string]$Row.rating)
    if ($rating -eq $null) { $rating = 0.0 }
    $conversionRate = Parse-PercentToPercentOrNull ([string]$Row.conversionRate)
    if ($conversionRate -eq $null) { $conversionRate = 0.0 }
    $conversionRate = [math]::Round([double]$conversionRate, 4)
    $revenue = Parse-CurrencyOrNull ([string]$Row.revenue)
    if ($revenue -eq $null) { $revenue = 0.0 }

    $fields = @{
        productId = $productId
        productName = $productName
        revenue = $revenue
        bookings = $bookings
        conversionRate = $conversionRate
        rating = $rating
        periodReviews = $periodReviews
        lastSyncedAt = (Get-Date).ToString('o')
    }

    $keys = @($fields.Keys)
    foreach ($k in $keys) {
        $v = $fields[$k]
        if ($v -eq $null) {
            $fields.Remove($k) | Out-Null
            continue
        }
        if ($v -is [string] -and [string]::IsNullOrWhiteSpace($v)) {
            $fields.Remove($k) | Out-Null
            continue
        }
    }

    return $fields
}

function Sync-GygToAirtable {
    param(
        [string]$TableName
    )

    $DryRun = $false
    if (-not [string]::IsNullOrWhiteSpace($env:GYG_AIRTABLE_DRY_RUN)) {
        $DryRun = $env:GYG_AIRTABLE_DRY_RUN.Trim().ToLower() -in @('1','true','yes','y','on')
    }

    $JsonFile = Join-Path $ScriptDir 'gyg_analytics.json'
    if (-not (Test-Path $JsonFile)) {
        throw "GYG output file not found: $JsonFile"
    }

    $Rows = Get-Content $JsonFile -Raw | ConvertFrom-Json
    if (-not $Rows -or $Rows.Count -eq 0) {
        throw 'GYG output file is empty'
    }

    $tableRef = $TableName
    if (-not [string]::IsNullOrWhiteSpace($env:GYG_AIRTABLE_TABLE_ID)) {
        $tableRef = $env:GYG_AIRTABLE_TABLE_ID.Trim()
        Write-Log "Using Airtable table id '$tableRef' (GYG_AIRTABLE_TABLE_ID set)." 'INFO'
    }

    $ExistingMap = @{}
    if (-not $DryRun) {
        try {
            Write-Log "Checking access to Airtable table '$tableRef'..." 'INFO'
            Test-AirtableTableAccess -TableRef $tableRef
            Write-Log "Airtable table access OK." 'SUCCESS'
        } catch {
            Write-Log "Cannot access Airtable table '$tableRef'. If this is a new table, create it in Airtable first and set GYG_AIRTABLE_TABLE_ID=tbl... (recommended). Error: $_" 'ERROR'
            throw
        }

        Write-Log "Loading existing records from Airtable table '$TableName'..." 'INFO'
        $Existing = Get-AirtableAllRecords -TableRef $tableRef -Fields @('productId')
        foreach ($r in $Existing) {
            $productIdKey = $r.fields.productId
            if ($productIdKey) {
                $ExistingMap[[string]$productIdKey] = [string]$r.id
            }
        }
        Write-Log "Existing Airtable records loaded: $($ExistingMap.Count)" 'INFO'
    }

    $MaxRows = 0
    if (-not [string]::IsNullOrWhiteSpace($env:GYG_AIRTABLE_MAX_ROWS)) {
        $n = [int]0
        if ([int]::TryParse($env:GYG_AIRTABLE_MAX_ROWS.Trim(), [ref]$n) -and $n -gt 0) {
            $MaxRows = $n
            Write-Log "Limiting Airtable sync to $MaxRows rows (GYG_AIRTABLE_MAX_ROWS=$($env:GYG_AIRTABLE_MAX_ROWS))." 'WARN'
        }
    }

    $Creates = @()
    $Updates = @()
    foreach ($row in $Rows) {
        if ($MaxRows -gt 0 -and ($Creates.Count + $Updates.Count) -ge $MaxRows) { break }
        $productIdKey = [string]($row.productId)
        if ([string]::IsNullOrWhiteSpace($productIdKey)) { continue }
        $fields = Convert-GygJsonToAirtableFields -Row $row
        if ($ExistingMap.ContainsKey($productIdKey)) {
            $Updates += @{ id = $ExistingMap[$productIdKey]; fields = $fields }
        } else {
            $Creates += @{ fields = $fields }
        }
    }

    $EncodedTableName = [System.Uri]::EscapeDataString($tableRef)
    $Endpoint = "https://api.airtable.com/v0/$($Config.Airtable.BaseId)/$EncodedTableName"

    Write-Log "Prepared upsert: create=$($Creates.Count), update=$($Updates.Count), total=$($Creates.Count + $Updates.Count)" 'INFO'
    if ($DryRun) {
        Write-Log 'Dry run enabled (GYG_AIRTABLE_DRY_RUN=true). No Airtable writes will be performed.' 'WARN'
        if ($Creates.Count -gt 0) {
            $sample = $Creates[0].fields | ConvertTo-Json -Compress
            Write-Log "Sample record fields: $sample" 'INFO'
        }
        return
    }

    $BatchSize = 10
    for ($i = 0; $i -lt $Creates.Count; $i += $BatchSize) {
        $batch = $Creates[$i..([Math]::Min($i + $BatchSize - 1, $Creates.Count - 1))]
        $body = @{ records = $batch; typecast = $true }
        [void](Invoke-AirtableRequest -Url $Endpoint -Method 'POST' -Body $body)
        Write-Log "Created batch: $($batch.Count)" 'SUCCESS'
        Start-Sleep -Milliseconds 250
    }

    for ($i = 0; $i -lt $Updates.Count; $i += $BatchSize) {
        $batch = $Updates[$i..([Math]::Min($i + $BatchSize - 1, $Updates.Count - 1))]
        $body = @{ records = $batch; typecast = $true }
        [void](Invoke-AirtableRequest -Url $Endpoint -Method 'PATCH' -Body $body)
        Write-Log "Updated batch: $($batch.Count)" 'SUCCESS'
        Start-Sleep -Milliseconds 250
    }
}

try {
    Write-Log '=== Starting GYG Airtable Sync ===' 'INFO'

    $TableName = $null
    if ($Config.Airtable.PSObject.Properties.Name -contains 'GygAnalyticsTable') {
        $TableName = $Config.Airtable.GygAnalyticsTable
    }
    if ([string]::IsNullOrWhiteSpace($TableName)) {
        $TableName = $env:GYG_AIRTABLE_TABLE_NAME
    }
    if ([string]::IsNullOrWhiteSpace($TableName)) {
        $TableName = 'GYG Analytics'
    }

    Start-GygScrape
    Sync-GygToAirtable -TableName $TableName

    Write-Log '=== GYG Airtable Sync Completed ===' 'SUCCESS'
} catch {
    $msg = $_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($msg)) { $msg = ($_ | Out-String).Trim() }
    Write-Log "GYG Airtable Sync failed: $msg" 'ERROR'
    if ($_.ScriptStackTrace) {
        Write-Log "Stack: $($_.ScriptStackTrace)" 'ERROR'
    }
    throw
}
