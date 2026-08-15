param(
  [string]$SourceMarkdown = "docs\CANONICAL_RETURNS_AND_REBALANCE_AUDIT_ARCHITECTURE_2026-08-15.md",
  [string]$OutputDocx = "docs\MINT_CANONICAL_RETURNS_AND_REBALANCE_AUDIT_2026-08-15.docx"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing

$Purple = [System.Drawing.Color]::FromArgb(103, 48, 190)
$PurpleDark = [System.Drawing.Color]::FromArgb(31, 13, 57)
$PurpleMid = [System.Drawing.Color]::FromArgb(131, 72, 222)
$PurpleLight = [System.Drawing.Color]::FromArgb(239, 232, 251)
$Ink = [System.Drawing.Color]::FromArgb(28, 24, 35)
$Muted = [System.Drawing.Color]::FromArgb(104, 96, 117)
$Green = [System.Drawing.Color]::FromArgb(16, 160, 104)
$Amber = [System.Drawing.Color]::FromArgb(222, 145, 24)
$Red = [System.Drawing.Color]::FromArgb(216, 70, 89)
$White = [System.Drawing.Color]::White
$Slate = [System.Drawing.Color]::FromArgb(245, 243, 248)
$BorderLineColor = [System.Drawing.Color]::FromArgb(214, 207, 224)

function To-WordColor([System.Drawing.Color]$Color) {
  return [int]($Color.R + 256 * $Color.G + 65536 * $Color.B)
}

function New-Font([float]$Size, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular) {
  return [System.Drawing.Font]::new("Segoe UI", $Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
}

function New-Canvas([string]$Path, [string]$Title, [string]$Kicker = "MINT CONTROLLED DATA FLOW") {
  $bitmap = [System.Drawing.Bitmap]::new(2400, 1350)
  $bitmap.SetResolution(150, 150)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $graphics.Clear($White)
  $graphics.FillRectangle([System.Drawing.SolidBrush]::new($PurpleDark), 0, 0, 2400, 180)
  $graphics.DrawString($Kicker, (New-Font 22 ([System.Drawing.FontStyle]::Bold)), [System.Drawing.SolidBrush]::new($PurpleLight), 90, 40)
  $graphics.DrawString($Title, (New-Font 45 ([System.Drawing.FontStyle]::Bold)), [System.Drawing.SolidBrush]::new($White), 90, 78)
  $graphics.FillRectangle([System.Drawing.SolidBrush]::new($Purple), 0, 180, 2400, 12)
  return @{ Bitmap = $bitmap; Graphics = $graphics; Path = $Path }
}

function Get-RoundedPath([System.Drawing.RectangleF]$Rect, [float]$Radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $path.AddArc($Rect.X, $Rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Rect.X, $Rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-Box(
  [System.Drawing.Graphics]$Graphics,
  [float]$X,
  [float]$Y,
  [float]$Width,
  [float]$Height,
  [string]$Title,
  [string]$Body = "",
  [System.Drawing.Color]$Fill = $Slate,
  [System.Drawing.Color]$Border = $Purple,
  [System.Drawing.Color]$TitleColor = $Ink
) {
  $rect = [System.Drawing.RectangleF]::new($X, $Y, $Width, $Height)
  $path = Get-RoundedPath $rect 24
  $Graphics.FillPath([System.Drawing.SolidBrush]::new($Fill), $path)
  $Graphics.DrawPath([System.Drawing.Pen]::new($Border, 4), $path)
  $titleFont = New-Font 28 ([System.Drawing.FontStyle]::Bold)
  $bodyFont = New-Font 21
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $titleRect = [System.Drawing.RectangleF]::new($X + 20, $Y + 16, $Width - 40, [Math]::Min(60, $Height * 0.42))
  $Graphics.DrawString($Title, $titleFont, [System.Drawing.SolidBrush]::new($TitleColor), $titleRect, $format)
  if ($Body) {
    $bodyRect = [System.Drawing.RectangleF]::new($X + 24, $Y + 62, $Width - 48, $Height - 76)
    $Graphics.DrawString($Body, $bodyFont, [System.Drawing.SolidBrush]::new($Muted), $bodyRect, $format)
  }
  $format.Dispose(); $titleFont.Dispose(); $bodyFont.Dispose(); $path.Dispose()
}

function Draw-Arrow(
  [System.Drawing.Graphics]$Graphics,
  [float]$X1,
  [float]$Y1,
  [float]$X2,
  [float]$Y2,
  [System.Drawing.Color]$Color = $Purple
) {
  $pen = [System.Drawing.Pen]::new($Color, 7)
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::ArrowAnchor
  $Graphics.DrawLine($pen, $X1, $Y1, $X2, $Y2)
  $pen.Dispose()
}

function Draw-Badge([System.Drawing.Graphics]$Graphics, [float]$X, [float]$Y, [string]$Text, [System.Drawing.Color]$Fill) {
  $font = New-Font 20 ([System.Drawing.FontStyle]::Bold)
  $size = $Graphics.MeasureString($Text, $font)
  $rect = [System.Drawing.RectangleF]::new($X, $Y, $size.Width + 34, 42)
  $path = Get-RoundedPath $rect 18
  $Graphics.FillPath([System.Drawing.SolidBrush]::new($Fill), $path)
  $Graphics.DrawString($Text, $font, [System.Drawing.SolidBrush]::new($White), $X + 17, $Y + 8)
  $font.Dispose(); $path.Dispose()
}

function Save-Canvas($Canvas) {
  $Canvas.Bitmap.Save($Canvas.Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $Canvas.Graphics.Dispose()
  $Canvas.Bitmap.Dispose()
}

function New-Cover([string]$Path) {
  $canvas = New-Canvas $Path "Canonical returns and rebalance evidence" "MINT | ARCHITECTURE & AUDIT"
  $g = $canvas.Graphics
  $g.FillRectangle([System.Drawing.SolidBrush]::new($PurpleLight), 0, 192, 2400, 1158)
  $centerX = 1200; $centerY = 735
  $g.FillEllipse([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(35, $Purple)), 790, 325, 820, 820)
  Draw-Box $g 900 555 600 300 "ONE CANONICAL LEDGER" "Official closes | model holdings`nmodel CA | execution evidence`nseven return ranges" $White $Purple $PurpleDark
  $nodes = @(
    @{ X=160; Y=310; T="MARKET CLOSES"; B="Exact JSE session" },
    @{ X=1640; Y=310; T="REBALANCES"; B="Settled fills + snapshots" },
    @{ X=160; Y=930; T="CASH IDENTITY"; B="CA != residual != reserve" },
    @{ X=1640; Y=930; T="PUBLIC SURFACES"; B="Card = factsheet = chart" }
  )
  foreach ($node in $nodes) { Draw-Box $g $node.X $node.Y 600 180 $node.T $node.B $White $PurpleMid }
  Draw-Arrow $g 760 400 925 600
  Draw-Arrow $g 1640 400 1475 600
  Draw-Arrow $g 760 1020 925 820
  Draw-Arrow $g 1475 820 1640 1020
  Draw-Badge $g 1015 1040 "FAIL CLOSED | AUDITABLE | REVERSIBLE" $Purple
  Save-Canvas $canvas
}

function New-MergeFlow([string]$Path) {
  $canvas = New-Canvas $Path "What merging deploys - and what remains gated"
  $g = $canvas.Graphics
  Draw-Box $g 100 285 470 190 "WN PR #96" "Merged | audit and DRAFT ledger machinery" $PurpleLight $Purple
  Draw-Box $g 100 760 470 190 "MINT PR #230" "Pending | exact EOD writer" $PurpleLight $Purple
  Draw-Box $g 750 500 520 220 "DRAFT CANONICAL LEDGER" "Calculated and inspectable`nnot yet public" $White $PurpleMid
  Draw-Box $g 1450 500 370 220 "CERTIFICATION" "Evidence gate" $White $Amber
  Draw-Box $g 1980 500 320 220 "PUBLIC UI" "Card | chart`nfactsheet" $White $Green
  Draw-Arrow $g 570 380 770 540
  Draw-Arrow $g 570 855 770 680
  Draw-Arrow $g 1270 610 1450 610
  Draw-Arrow $g 1820 610 1980 610
  Draw-Badge $g 1470 785 "NO AUTOMATIC PROMOTION" $Red
  Save-Canvas $canvas
}

function New-BeforeAfter([string]$Path) {
  $canvas = New-Canvas $Path "From competing calculations to one controlled read model"
  $g = $canvas.Graphics
  $g.DrawString("BEFORE", (New-Font 30 ([System.Drawing.FontStyle]::Bold)), [System.Drawing.SolidBrush]::new($Red), 150, 245)
  $g.DrawString("AFTER", (New-Font 30 ([System.Drawing.FontStyle]::Bold)), [System.Drawing.SolidBrush]::new($Green), 1320, 245)
  $before = @("Latest intraday as close", "Current basket recomputation", "Legacy pre-inception seed", "Unsealed composition jump")
  for ($i=0; $i -lt $before.Count; $i++) { Draw-Box $g 100 (320 + $i*205) 740 145 $before[$i] "Competing input" ([System.Drawing.Color]::FromArgb(255, 242, 244)) $Red }
  Draw-Box $g 880 565 300 220 "DRIFT" "Different dates`nand values" ([System.Drawing.Color]::FromArgb(255, 242, 244)) $Red $Red
  for ($i=0; $i -lt $before.Count; $i++) { Draw-Arrow $g 840 (390 + $i*205) 900 (600 + $i*15) $Red }
  $after = @(
    @{Y=320;T="Official exact close";B="Date + unit + scale guard"},
    @{Y=520;T="Effective composition";B="Actual strategy inception"},
    @{Y=720;T="Settled boundary evidence";B="Fills + snapshots + CA"},
    @{Y=920;T="Canonical ledger";B="One value and seven ranges"}
  )
  foreach ($item in $after) { Draw-Box $g 1300 $item.Y 900 145 $item.T $item.B $White $Green }
  Draw-Arrow $g 1750 465 1750 520 $Green; Draw-Arrow $g 1750 665 1750 720 $Green; Draw-Arrow $g 1750 865 1750 920 $Green
  Save-Canvas $canvas
}

function New-CashModel([string]$Path) {
  $canvas = New-Canvas $Path "Three cash concepts - deliberately separated"
  $g = $canvas.Graphics
  Draw-Box $g 890 250 620 170 "CLIENT PURCHASE" "One transaction | one owner" $PurpleLight $Purple
  Draw-Box $g 250 570 520 190 "BASE INVESTMENT" "Securities budget + model CA" $White $Purple
  Draw-Box $g 940 570 520 190 "8% RESERVE" "Fees and execution tolerance" ([System.Drawing.Color]::FromArgb(255, 248, 231)) $Amber
  Draw-Box $g 1630 570 520 190 "OWNER RESIDUAL" "Unspent / realised owner cash" ([System.Drawing.Color]::FromArgb(240, 249, 246)) $Green
  Draw-Arrow $g 1050 420 620 570; Draw-Arrow $g 1200 420 1200 570; Draw-Arrow $g 1350 420 1780 570
  Draw-Box $g 250 920 520 170 "PUBLIC MODEL VALUE" "Securities + strategy/model CA" $PurpleLight $Purple
  Draw-Arrow $g 510 760 510 920
  $g.DrawString("EXCLUDED", (New-Font 24 ([System.Drawing.FontStyle]::Bold)), [System.Drawing.SolidBrush]::new($Red), 1070, 940)
  $g.DrawString("EXCLUDED", (New-Font 24 ([System.Drawing.FontStyle]::Bold)), [System.Drawing.SolidBrush]::new($Red), 1760, 940)
  Draw-Badge $g 850 1140 "MODEL CA != OWNER RESIDUAL != EXECUTION RESERVE" $PurpleDark
  Save-Canvas $canvas
}

function New-Architecture([string]$Path) {
  $canvas = New-Canvas $Path "End-to-end canonical return architecture"
  $g = $canvas.Graphics
  $columns = @(
    @{X=70;T="MARKET";C=$PurpleLight}, @{X=510;T="MINT LIVE";C=$PurpleLight},
    @{X=950;T="RETAIL DATA";C=$PurpleLight}, @{X=1390;T="WEALTH NAVIGATOR";C=$PurpleLight},
    @{X=1830;T="PUBLIC";C=$PurpleLight}
  )
  foreach ($column in $columns) { Draw-Box $g $column.X 235 370 95 $column.T "" $column.C $Purple }
  Draw-Box $g 70 410 370 150 "Yahoo / IRESS" "Independent daily evidence" $White $PurpleMid
  Draw-Box $g 510 410 370 150 "EOD guard" "Exact date | unit | scale" $White $PurpleMid
  Draw-Box $g 950 380 370 130 "stock_returns_c" "Official stored cents" $White $PurpleMid
  Draw-Box $g 950 570 370 130 "composition + rules" "Holdings + model CA" $White $PurpleMid
  Draw-Box $g 950 760 370 130 "rebalance evidence" "Batch | fills | cash" $White $PurpleMid
  Draw-Box $g 1390 500 370 170 "DRAFT writer" "Fail-closed continuation" $White $PurpleMid
  Draw-Box $g 1390 790 370 150 "Certification audit" "Workbook + provider proof" $White $Amber
  Draw-Box $g 1830 500 480 170 "Certified adapter" "Strategy-by-strategy cutover" $White $Green
  Draw-Box $g 1830 790 480 150 "One visible truth" "Card = chart = factsheet" $White $Green
  Draw-Arrow $g 440 485 510 485; Draw-Arrow $g 880 485 950 445; Draw-Arrow $g 1320 445 1390 540
  Draw-Arrow $g 1320 635 1390 585; Draw-Arrow $g 1320 825 1390 625
  Draw-Arrow $g 1575 670 1575 790; Draw-Arrow $g 1760 865 1830 865; Draw-Arrow $g 2070 790 2070 670
  Save-Canvas $canvas
}

function New-Erd([string]$Path) {
  $canvas = New-Canvas $Path "Returns and rebalance evidence - logical ERD"
  $g = $canvas.Graphics
  $entities = @(
    @{X=80;Y=280;T="strategies_c";B="id | name | inception"},
    @{X=80;Y=520;T="composition_log_c";B="effective dates | holdings"},
    @{X=80;Y=760;T="valuation_rules_c";B="securities | model CA"},
    @{X=720;Y=280;T="rebalance_batch";B="before | planned | after"},
    @{X=720;Y=520;T="rebalance_event";B="BUY/SELL | fill | date"},
    @{X=720;Y=760;T="CA reconciliation";B="capital = securities + CA"},
    @{X=1360;Y=280;T="stock_returns_c";B="symbol | date | close cents"},
    @{X=1360;Y=600;T="canonical_daily_ledger_c";B="value | legs | ranges | evidence"},
    @{X=1950;Y=600;T="certified consumers";B="cards | factsheets | charts"}
  )
  foreach ($e in $entities) { Draw-Box $g $e.X $e.Y 460 165 $e.T $e.B $White $PurpleMid }
  Draw-Arrow $g 310 445 310 520; Draw-Arrow $g 310 685 310 760
  Draw-Arrow $g 540 360 720 360; Draw-Arrow $g 950 445 950 520; Draw-Arrow $g 950 685 950 760
  Draw-Arrow $g 540 845 1360 735; Draw-Arrow $g 1180 845 1360 735; Draw-Arrow $g 1590 445 1590 600
  Draw-Arrow $g 1820 685 1950 685
  Draw-Badge $g 780 1090 "EVIDENCE TABLES REMAIN | COMPETING RETURN CALCULATIONS RETIRE" $PurpleDark
  Save-Canvas $canvas
}

function New-RepairChart([string]$Path) {
  $canvas = New-Canvas $Path "Historical close correction - reviewed operations"
  $g = $canvas.Graphics
  $labels = @("Existing closes corrected", "Missing bars inserted", "Exact-cent corrections", "STXID rows restored")
  $values = @(728, 139, 25, 11)
  $colors = @($Purple, $PurpleMid, $Amber, $Green)
  $max = 750
  for ($i=0; $i -lt $values.Count; $i++) {
    $y = 300 + $i * 220
    $g.DrawString($labels[$i], (New-Font 25 ([System.Drawing.FontStyle]::Bold)), [System.Drawing.SolidBrush]::new($Ink), 110, $y)
    $g.FillRectangle([System.Drawing.SolidBrush]::new($Slate), 760, $y, 1400, 82)
    $barWidth = 1400 * ($values[$i] / $max)
    $g.FillRectangle([System.Drawing.SolidBrush]::new($colors[$i]), 760, $y, $barWidth, 82)
    $g.DrawString([string]$values[$i], (New-Font 30 ([System.Drawing.FontStyle]::Bold)), [System.Drawing.SolidBrush]::new($Ink), 2180, $y + 20)
  }
  Draw-Badge $g 900 1190 "FINAL IDEMPOTENCY RUN: 0 CHANGES" $Green
  Save-Canvas $canvas
}

function New-EodSequence([string]$Path) {
  $canvas = New-Canvas $Path "Daily EOD close and canonical continuation sequence"
  $g = $canvas.Graphics
  $actors = @("17:45 cron", "MINT EOD API", "Yahoo daily", "Guard", "stock_returns_c", "DRAFT ledger")
  $xs = @(110, 480, 850, 1220, 1590, 1960)
  for ($i=0; $i -lt $actors.Count; $i++) {
    Draw-Box $g $xs[$i] 245 300 100 $actors[$i] "" $PurpleLight $Purple
    $g.DrawLine([System.Drawing.Pen]::new($BorderLineColor, 3), $xs[$i]+150, 345, $xs[$i]+150, 1160)
  }
  $steps = @(
    @{A=0;B=1;Y=430;T="run JSE date"}, @{A=1;B=2;Y=545;T="request exact candle"},
    @{A=2;B=3;Y=660;T="date + close + unit"}, @{A=3;B=4;Y=775;T="valid cents only"},
    @{A=4;B=5;Y=890;T="exact same-day prices"}
  )
  foreach ($s in $steps) {
    Draw-Arrow $g ($xs[$s.A]+150) $s.Y ($xs[$s.B]+150) $s.Y
    $g.DrawString($s.T, (New-Font 19 ([System.Drawing.FontStyle]::Bold)), [System.Drawing.SolidBrush]::new($Muted), (($xs[$s.A]+$xs[$s.B])/2)+70, $s.Y-38)
  }
  Draw-Badge $g 700 1070 "MISSING / UNSUPPORTED / SCALE-DIVERGENT = SKIP, NEVER GUESS" $Red
  Save-Canvas $canvas
}

function New-RebalanceFlow([string]$Path) {
  $canvas = New-Canvas $Path "Evidence required to cross a rebalance boundary"
  $g = $canvas.Graphics
  $steps = @(
    @{X=80;Y=270;T="MODEL CHANGE";B="Composition or CA differs"},
    @{X=560;Y=270;T="ONE SETTLED BATCH";B="Complete | not reversed"},
    @{X=1040;Y=270;T="SNAPSHOTS MATCH";B="Old and new baskets"},
    @{X=1520;Y=270;T="FILLS RESOLVE";B="Dated | positive | one scale"},
    @{X=1040;Y=700;T="CA RECONCILES";B="Owners complete | identity holds"},
    @{X=560;Y=700;T="REBUILD LEGS";B="Freeze sells | open buys"},
    @{X=80;Y=700;T="WRITE DRAFT";B="Explicit bridge + evidence hash"}
  )
  foreach ($s in $steps) { Draw-Box $g $s.X $s.Y 400 175 $s.T $s.B $White $PurpleMid }
  Draw-Arrow $g 480 355 560 355; Draw-Arrow $g 960 355 1040 355; Draw-Arrow $g 1440 355 1520 355
  Draw-Arrow $g 1720 445 1240 700; Draw-Arrow $g 1040 785 960 785; Draw-Arrow $g 560 785 480 785
  Draw-Box $g 1840 700 470 175 "FAIL CLOSED" "No batch | multiple batches`nmissing fills | unexplained capital" ([System.Drawing.Color]::FromArgb(255, 242, 244)) $Red $Red
  Draw-Badge $g 750 1070 "NO REBALANCE SPIKE | NO INVENTED CAPITAL" $Green
  Save-Canvas $canvas
}

function New-CertificationChart([string]$Path) {
  $canvas = New-Canvas $Path "Canonical certification - current family status"
  $g = $canvas.Graphics
  $center = [System.Drawing.PointF]::new(620, 730)
  $rect = [System.Drawing.Rectangle]::new(220, 330, 800, 800)
  $g.FillPie([System.Drawing.SolidBrush]::new($Green), $rect, -90, 45)
  $g.FillPie([System.Drawing.SolidBrush]::new($PurpleLight), $rect, -45, 315)
  $g.FillEllipse([System.Drawing.SolidBrush]::new($White), 390, 500, 460, 460)
  $format = [System.Drawing.StringFormat]::new(); $format.Alignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString("1 / 8", (New-Font 64 ([System.Drawing.FontStyle]::Bold)), [System.Drawing.SolidBrush]::new($PurpleDark), [System.Drawing.RectangleF]::new(390, 610, 460, 100), $format)
  $g.DrawString("fully evidenced", (New-Font 27 ([System.Drawing.FontStyle]::Bold)), [System.Drawing.SolidBrush]::new($Muted), [System.Drawing.RectangleF]::new(390, 720, 460, 70), $format)
  Draw-Box $g 1180 330 1050 180 "MINT FAMOUS BRANDS" "0 missing | 0 mismatches | 0 formula failures" ([System.Drawing.Color]::FromArgb(236, 250, 244)) $Green $Green
  Draw-Box $g 1180 590 1050 180 "SEVEN STRATEGIES" "Internally exact; independent evidence incomplete" $PurpleLight $Purple
  Draw-Box $g 1180 850 1050 180 "SAFETY RESULT" "Missing evidence remains DRAFT - never counted as a match" ([System.Drawing.Color]::FromArgb(255, 248, 231)) $Amber $Amber
  $format.Dispose()
  Save-Canvas $canvas
}

function New-PromotionFlow([string]$Path) {
  $canvas = New-Canvas $Path "Controlled strategy-by-strategy public cutover"
  $g = $canvas.Graphics
  $steps = @(
    @{X=80;T="FRESH AUDIT";B="Provider + workbook"},
    @{X=520;T="PROMOTION RECORD";B="Reviewed and attributable"},
    @{X=960;T="CERTIFIED ROWS";B="Protected from DRAFT replay"},
    @{X=1400;T="PUBLIC ADAPTER";B="One strategy first"},
    @{X=1840;T="VISUAL PROOF";B="Card = chart = factsheet"}
  )
  foreach ($s in $steps) { Draw-Box $g $s.X 470 380 210 $s.T $s.B $White $PurpleMid }
  for ($i=0; $i -lt 4; $i++) { Draw-Arrow $g (460 + $i*440) 575 (520 + $i*440) 575 }
  Draw-Box $g 770 850 860 170 "ROLLBACK READ PATH" "If any surface disagrees, restore the prior adapter; preserve the evidence" ([System.Drawing.Color]::FromArgb(255, 242, 244)) $Red $Red
  Draw-Badge $g 820 1130 "FIRST PRODUCTION PROOF: MINT FAMOUS BRANDS" $Green
  Save-Canvas $canvas
}

function Add-WordParagraph($Selection, [string]$Text, [string]$Style = "Normal", [int]$Color = -16777216, [float]$SpaceAfter = 6) {
  $Selection.Style = $Style
  $Selection.Font.Color = $Color
  $Selection.TypeText($Text)
  $Selection.ParagraphFormat.SpaceAfter = $SpaceAfter
  $Selection.TypeParagraph()
}

function Convert-InlineMarkdown([string]$Text) {
  $value = $Text -replace '\*\*', ''
  $value = $value -replace '`', ''
  $value = [regex]::Replace($value, '\[([^\]]+)\]\(([^\)]+)\)', '$1 ($2)')
  return $value
}

function Add-WordTable($Document, $Selection, [object[]]$Rows) {
  if ($Rows.Count -lt 2) { return }
  $columnCount = ($Rows | ForEach-Object { $_.Count } | Measure-Object -Maximum).Maximum
  $table = $Document.Tables.Add($Selection.Range, $Rows.Count, $columnCount)
  $table.AllowAutoFit = $true
  $table.AutoFitBehavior(2)
  $table.Rows.AllowBreakAcrossPages = $false
  for ($r = 0; $r -lt $Rows.Count; $r++) {
    for ($c = 0; $c -lt $columnCount; $c++) {
      $text = if ($c -lt $Rows[$r].Count) { Convert-InlineMarkdown ([string]$Rows[$r][$c]) } else { "" }
      $cell = $table.Cell($r + 1, $c + 1)
      $cell.Range.Text = $text
      $cell.Range.Font.Name = "Aptos"
      $cell.Range.Font.Size = 8.5
      $cell.VerticalAlignment = 1
      $cell.TopPadding = 5; $cell.BottomPadding = 5; $cell.LeftPadding = 5; $cell.RightPadding = 5
      if ($r -eq 0) {
        $cell.Shading.BackgroundPatternColor = To-WordColor $PurpleDark
        $cell.Range.Font.Color = To-WordColor $White
        $cell.Range.Font.Bold = $true
      } elseif ($r % 2 -eq 0) {
        $cell.Shading.BackgroundPatternColor = To-WordColor $Slate
      }
    }
  }
  $table.Borders.OutsideColor = To-WordColor $BorderLineColor
  $table.Borders.InsideColor = To-WordColor $BorderLineColor
  $Selection.SetRange($table.Range.End, $table.Range.End)
  $Selection.TypeParagraph()
}

function Add-CodeBlock($Selection, [string[]]$Lines) {
  foreach ($line in $Lines) {
    $Selection.Style = "Normal"
    $Selection.Font.Name = "Consolas"
    $Selection.Font.Size = 8.5
    $Selection.Font.Color = To-WordColor $PurpleDark
    $Selection.ParagraphFormat.LeftIndent = 18
    $Selection.ParagraphFormat.RightIndent = 18
    $Selection.ParagraphFormat.SpaceAfter = 0
    $Selection.Shading.BackgroundPatternColor = To-WordColor $Slate
    $Selection.TypeText($line)
    $Selection.TypeParagraph()
  }
  $Selection.ParagraphFormat.LeftIndent = 0
  $Selection.ParagraphFormat.RightIndent = 0
  $Selection.Shading.BackgroundPatternColor = To-WordColor $White
  $Selection.TypeParagraph()
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$source = (Resolve-Path (Join-Path $root $SourceMarkdown)).Path
$output = [System.IO.Path]::GetFullPath((Join-Path $root $OutputDocx))
$assetRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("mint-canonical-audit-" + [guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($assetRoot) | Out-Null

$illustrations = @(
  @{ Name="merge"; Title="Merge behaviour"; Builder={ param($p) New-MergeFlow $p } },
  @{ Name="before-after"; Title="Before and after architecture"; Builder={ param($p) New-BeforeAfter $p } },
  @{ Name="cash"; Title="Cash separation model"; Builder={ param($p) New-CashModel $p } },
  @{ Name="architecture"; Title="End-to-end architecture"; Builder={ param($p) New-Architecture $p } },
  @{ Name="erd"; Title="Logical database ERD"; Builder={ param($p) New-Erd $p } },
  @{ Name="repair"; Title="Historical correction chart"; Builder={ param($p) New-RepairChart $p } },
  @{ Name="eod"; Title="Daily EOD sequence"; Builder={ param($p) New-EodSequence $p } },
  @{ Name="rebalance"; Title="Rebalance boundary flow"; Builder={ param($p) New-RebalanceFlow $p } },
  @{ Name="certification"; Title="Certification status"; Builder={ param($p) New-CertificationChart $p } },
  @{ Name="promotion"; Title="Controlled promotion flow"; Builder={ param($p) New-PromotionFlow $p } }
)

$coverPath = Join-Path $assetRoot "cover.png"
New-Cover $coverPath
foreach ($illustration in $illustrations) {
  $path = Join-Path $assetRoot ($illustration.Name + ".png")
  & $illustration.Builder $path
  $illustration.Path = $path
}

$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $document = $word.Documents.Add()
  $selection = $word.Selection

  $document.PageSetup.PaperSize = 7
  $document.PageSetup.TopMargin = 42
  $document.PageSetup.BottomMargin = 42
  $document.PageSetup.LeftMargin = 46
  $document.PageSetup.RightMargin = 46
  $document.PageSetup.DifferentFirstPageHeaderFooter = $true

  $normal = $document.Styles.Item("Normal")
  $normal.Font.Name = "Aptos"
  $normal.Font.Size = 9.5
  $normal.Font.Color = To-WordColor $Ink
  $normal.ParagraphFormat.SpaceAfter = 6
  $normal.ParagraphFormat.LineSpacingRule = 0

  foreach ($styleName in @("Heading 1", "Heading 2", "Heading 3")) {
    $style = $document.Styles.Item($styleName)
    $style.Font.Name = "Aptos Display"
    $style.Font.Color = To-WordColor $PurpleDark
  }
  $document.Styles.Item("Heading 1").Font.Size = 20
  $document.Styles.Item("Heading 1").ParagraphFormat.SpaceBefore = 18
  $document.Styles.Item("Heading 1").ParagraphFormat.SpaceAfter = 8
  $document.Styles.Item("Heading 2").Font.Size = 14
  $document.Styles.Item("Heading 2").ParagraphFormat.SpaceBefore = 12
  $document.Styles.Item("Heading 2").ParagraphFormat.SpaceAfter = 6
  $document.Styles.Item("Heading 3").Font.Size = 11

  # Cover
  $selection.ParagraphFormat.Alignment = 0
  $selection.Font.Name = "Aptos Display"
  $selection.Font.Size = 18
  $selection.Font.Bold = $true
  $selection.Font.Color = To-WordColor $Purple
  $selection.TypeText("MINT")
  $selection.TypeParagraph()
  $selection.Font.Size = 9
  $selection.Font.Bold = $true
  $selection.Font.Color = To-WordColor $Muted
  $selection.TypeText("TECHNICAL AUDIT | ARCHITECTURE | CUTOVER RUNBOOK")
  $selection.TypeParagraph(); $selection.TypeParagraph()
  $selection.Font.Size = 32
  $selection.Font.Bold = $true
  $selection.Font.Color = To-WordColor $PurpleDark
  $selection.TypeText("Canonical returns and`nrebalance evidence programme")
  $selection.TypeParagraph()
  $selection.Font.Size = 13
  $selection.Font.Bold = $false
  $selection.Font.Color = To-WordColor $Muted
  $selection.TypeText("From exact JSE closes to a certified public strategy ledger")
  $selection.TypeParagraph(); $selection.TypeParagraph()
  $shape = $selection.InlineShapes.AddPicture($coverPath)
  $shape.LockAspectRatio = -1
  $shape.Width = 500
  $selection.TypeParagraph()
  $coverTable = $document.Tables.Add($selection.Range, 2, 2)
  $coverValues = @(
    @("AS AT", "15 AUGUST 2026"),
    @("SYSTEMS", "WEALTH NAVIGATOR | RETAIL | INSTITUTIONAL | MINT LIVE")
  )
  for ($r=1; $r -le 2; $r++) {
    for ($c=1; $c -le 2; $c++) {
      $coverTable.Cell($r,$c).Range.Text = $coverValues[$r-1][$c-1]
      $coverTable.Cell($r,$c).Range.Font.Name = "Aptos"
      $coverTable.Cell($r,$c).Range.Font.Size = if ($c -eq 1) { 8 } else { 9 }
      $coverTable.Cell($r,$c).Range.Font.Bold = $true
      $coverTable.Cell($r,$c).Range.Font.Color = if ($c -eq 1) { To-WordColor $Purple } else { To-WordColor $Ink }
      $coverTable.Cell($r,$c).Shading.BackgroundPatternColor = To-WordColor $Slate
    }
  }
  $coverTable.Borders.Enable = 0
  $selection.SetRange($coverTable.Range.End, $coverTable.Range.End)
  $selection.InsertBreak(7)

  # Contents
  Add-WordParagraph $selection "Contents" "Heading 1" (To-WordColor $PurpleDark) 8
  $toc = $document.TablesOfContents.Add($selection.Range, $true, 1, 3)
  $selection.SetRange($toc.Range.End, $toc.Range.End)
  $selection.InsertBreak(7)

  $lines = Get-Content -LiteralPath $source -Encoding UTF8
  $started = $false
  $i = 0
  $figureIndex = 0
  while ($i -lt $lines.Count) {
    $line = [string]$lines[$i]
    if (-not $started) {
      if ($line -match '^## 1\.') { $started = $true } else { $i++; continue }
    }

    if ($line -match '^```mermaid\s*$') {
      $i++
      while ($i -lt $lines.Count -and $lines[$i] -notmatch '^```\s*$') { $i++ }
      if ($figureIndex -lt $illustrations.Count) {
        $selection.ParagraphFormat.Alignment = 1
        $picture = $selection.InlineShapes.AddPicture($illustrations[$figureIndex].Path)
        $picture.LockAspectRatio = -1
        $picture.Width = 495
        $selection.TypeParagraph()
        $selection.Font.Name = "Aptos"
        $selection.Font.Size = 8
        $selection.Font.Italic = $true
        $selection.Font.Color = To-WordColor $Muted
        $selection.TypeText("Figure " + ($figureIndex + 1) + " - " + $illustrations[$figureIndex].Title)
        $selection.TypeParagraph()
        $selection.ParagraphFormat.Alignment = 0
        $selection.Font.Italic = $false
        $figureIndex++
      }
      $i++; continue
    }

    if ($line -match '^```') {
      $code = [System.Collections.Generic.List[string]]::new()
      $i++
      while ($i -lt $lines.Count -and $lines[$i] -notmatch '^```\s*$') { $code.Add([string]$lines[$i]); $i++ }
      Add-CodeBlock $selection $code.ToArray()
      $i++; continue
    }

    if ($line -match '^## (.+)$') {
      $heading = Convert-InlineMarkdown $Matches[1]
      if ($heading -match '^(5|7|9|13|15|20)\.') { $selection.InsertBreak(7) }
      Add-WordParagraph $selection $heading "Heading 1" (To-WordColor $PurpleDark) 8
      $i++; continue
    }
    if ($line -match '^### (.+)$') {
      Add-WordParagraph $selection (Convert-InlineMarkdown $Matches[1]) "Heading 2" (To-WordColor $Purple) 6
      $i++; continue
    }
    if ($line -match '^#### (.+)$') {
      Add-WordParagraph $selection (Convert-InlineMarkdown $Matches[1]) "Heading 3" (To-WordColor $PurpleMid) 4
      $i++; continue
    }

    if ($line -match '^\|' -and $i + 1 -lt $lines.Count -and $lines[$i+1] -match '^\|?\s*:?-+') {
      $rows = [System.Collections.Generic.List[object]]::new()
      $headerCells = @($line.Trim('|').Split('|') | ForEach-Object { $_.Trim() })
      $rows.Add($headerCells)
      $i += 2
      while ($i -lt $lines.Count -and $lines[$i] -match '^\|') {
        $cells = @(([string]$lines[$i]).Trim('|').Split('|') | ForEach-Object { $_.Trim() })
        $rows.Add($cells)
        $i++
      }
      Add-WordTable $document $selection $rows.ToArray()
      continue
    }

    if ($line -match '^\s*[-*] \[( |x)\] (.+)$') {
      $checked = $Matches[1] -eq 'x'
      $mark = if ($checked) { "[x]" } else { "[ ]" }
      Add-WordParagraph $selection ("$mark " + (Convert-InlineMarkdown $Matches[2])) "Normal" (To-WordColor $(if ($checked) { $Green } else { $Ink })) 3
      $i++; continue
    }
    if ($line -match '^\s*[-*] (.+)$') {
      Add-WordParagraph $selection ("- " + (Convert-InlineMarkdown $Matches[1])) "Normal" (To-WordColor $Ink) 3
      $i++; continue
    }
    if ($line -match '^\s*(\d+)\. (.+)$') {
      Add-WordParagraph $selection ($Matches[1] + ". " + (Convert-InlineMarkdown $Matches[2])) "Normal" (To-WordColor $Ink) 3
      $i++; continue
    }
    if ($line -match '^---\s*$') {
      $selection.Font.Name = "Aptos"
      $selection.Font.Size = 5
      $selection.Font.Color = To-WordColor $PurpleLight
      $selection.TypeText("________________________________________________________________________________")
      $selection.TypeParagraph()
      $i++; continue
    }
    if ([string]::IsNullOrWhiteSpace($line)) { $i++; continue }

    $paragraph = [System.Collections.Generic.List[string]]::new()
    while ($i -lt $lines.Count) {
      $candidate = [string]$lines[$i]
      if ([string]::IsNullOrWhiteSpace($candidate) -or $candidate -match '^(##|###|####|```|\||---|\s*[-*] |\s*\d+\. )') { break }
      $paragraph.Add($candidate.Trim())
      $i++
    }
    if ($paragraph.Count -gt 0) {
      Add-WordParagraph $selection (Convert-InlineMarkdown ($paragraph -join " ")) "Normal" (To-WordColor $Ink) 6
    } else { $i++ }
  }

  # Header and footer
  $section = $document.Sections.Item(1)
  $header = $section.Headers.Item(1).Range
  $header.Text = "MINT  |  CANONICAL RETURNS & REBALANCE EVIDENCE"
  $header.Font.Name = "Aptos"
  $header.Font.Size = 8
  $header.Font.Bold = $true
  $header.Font.Color = To-WordColor $Purple
  $header.ParagraphFormat.Alignment = 0
  $footer = $section.Footers.Item(1).Range
  $footer.Text = "CONTROLLED TECHNICAL AUDIT  |  15 AUGUST 2026     "
  $footer.Font.Name = "Aptos"
  $footer.Font.Size = 8
  $footer.Font.Color = To-WordColor $Muted
  $footer.ParagraphFormat.Alignment = 2
  $footer.Collapse(0)
  $footer.Fields.Add($footer, 33) | Out-Null

  foreach ($contents in $document.TablesOfContents) { $contents.Update() }
  $document.Fields.Update() | Out-Null
  $document.Repaginate()
  $document.SaveAs2($output, 16)

  $summary = [ordered]@{
    output = $output
    pages = $document.ComputeStatistics(2)
    words = $document.ComputeStatistics(0)
    tables = $document.Tables.Count
    images = $document.InlineShapes.Count
    headings = @($document.Paragraphs | Where-Object { $_.OutlineLevel -in 1,2,3 }).Count
    toc = $document.TablesOfContents.Count
    bytes = (Get-Item $output).Length
  }
  $summary | ConvertTo-Json
}
finally {
  if ($document) { $document.Close($false) }
  if ($word) { $word.Quit() }
  if (Test-Path -LiteralPath $assetRoot) { Remove-Item -LiteralPath $assetRoot -Recurse -Force }
  [gc]::Collect()
  [gc]::WaitForPendingFinalizers()
}
