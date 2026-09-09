<?php

declare(strict_types=1);

/**
 * Tests read ../conformance.json, the shared truth for every SDK, so a fold that
 * drifts here fails here. No PHPUnit dependency: plain assertions, runnable with
 * `php test/DetectorTest.php`.
 */

require __DIR__ . '/../src/Detector.php';
require __DIR__ . '/../src/Bridge.php';

use Scrapeless\Detector\Bridge;
use Scrapeless\Detector\Categories;
use Scrapeless\Detector\Result;

$passed = 0;
$failed = 0;

function check(bool $condition, string $label): void
{
    global $passed, $failed;
    if ($condition) {
        $passed++;
        return;
    }
    $failed++;
    fwrite(STDERR, "  FAIL {$label}\n");
}

$vectors = json_decode(file_get_contents(__DIR__ . '/../../conformance.json'), true, 512, JSON_THROW_ON_ERROR);

foreach ($vectors['categoryFold'] as $vector) {
    check(
        Categories::keyOf(['category' => $vector['raw']]) === $vector['expect'],
        sprintf('fold %s -> %s', json_encode($vector['raw']), $vector['expect'])
    );
}

foreach ($vectors['results'] as $vector) {
    $result = Result::build(true, $vector['detail']);
    $want = $vector['expect'];
    $name = $vector['name'];

    check($result->available === $want['available'], "{$name}: available");
    check($result->total === $want['total'], "{$name}: total");
    check($result->reportedTotal === $want['reportedTotal'], "{$name}: reportedTotal");
    check($result->categories === $want['categories'], "{$name}: categories");
    check($result->isAntibot() === $want['isAntibot'], "{$name}: isAntibot");
    check($result->isProtected() === $want['isProtected'], "{$name}: isProtected");

    if (isset($want['firstName'])) {
        check($result->detections[0]->name === $want['firstName'], "{$name}: firstName");
        check($result->detections[0]->categoryKey === $want['firstCategoryKey'], "{$name}: firstCategoryKey");
    }
    if ($want['lastConfidenceIsNull'] ?? false) {
        $last = $result->detections[count($result->detections) - 1];
        check($last->confidence === null, "{$name}: a non-numeric confidence must be null");
    }
}

$want = $vectors['unavailable']['expect'];
$result = Result::unavailable();
check($result->available === $want['available'], 'unavailable: available');
check($result->reason === $want['reason'], 'unavailable: reason');
check($result->total === $want['total'], 'unavailable: total');
check($result->isAntibot() === $want['isAntibot'], 'unavailable: isAntibot');
check($result->isProtected() === $want['isProtected'], 'unavailable: isProtected');

$canonical = trim(file_get_contents(__DIR__ . '/../../bridge.js'));
check(trim(Bridge::INIT_SCRIPT) === $canonical, 'src/Bridge.php matches scrapeless-sdks/bridge.js');

$sample = $vectors['results'][0]['detail'];
$result = Result::build(true, $sample);
check(count($result->ofCategory('antibot')) === 1, 'ofCategory filters to one bucket');
check($result->ofCategory('antibot')[0]->name === 'Cloudflare Bot Management', 'ofCategory returns the right one');

$kept = Result::build(true, ['detections' => [['name' => 'Akamai', 'vendorNote' => 'keep me']]]);
check($kept->detections[0]->get('vendorNote') === 'keep me', 'original fields survive');

check(Categories::keyOf(['detector' => ['category' => 'Anti-Bot']]) === 'antibot', 'nested detector shape');
check(Categories::keyOf(null) === 'other', 'non-array input folds to other');

printf("\n  %d passed, %d failed\n", $passed, $failed);
exit($failed > 0 ? 1 : 0);
