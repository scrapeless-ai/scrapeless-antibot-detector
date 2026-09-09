<?php

declare(strict_types=1);

namespace Scrapeless\Detector;

/**
 * Scrapeless Anti-Bot Detector — PHP SDK.
 *
 * PHP cannot hear the extension directly. The extension talks to the *page*, by
 * dispatching CustomEvents at window, so this SDK drives a real Chrome with the
 * extension loaded (php-webdriver + ChromeDriver's CDP passthrough) and reads
 * the result back out of the document.
 *
 * Every wait is bounded: the page API ships disabled and the extension may be
 * absent, and neither announces itself. A Result carrying available=false comes
 * back instead of a hang. Check isAvailable() before trusting a false.
 */
final class Categories
{
    public const ANTIBOT = 'antibot';
    public const CAPTCHA = 'captcha';
    public const FINGERPRINT = 'fingerprint';
    public const OTHER = 'other';

    /**
     * The bundled detectors ship four spellings — 'Anti-Bot', 'ANTIBOT',
     * 'CAPTCHA', 'Fingerprint' — so comparing against one matches almost
     * nothing. Fold, then alias.
     */
    private const ALIASES = [
        'antibot' => self::ANTIBOT,
        'waf' => self::ANTIBOT,
        'captcha' => self::CAPTCHA,
        'fingerprint' => self::FINGERPRINT,
        'fingerprinting' => self::FINGERPRINT,
    ];

    /** Fold any category spelling to one of the four keys. */
    public static function keyOf(mixed $detection): string
    {
        $raw = '';
        if (is_array($detection)) {
            if (isset($detection['category']) && $detection['category'] !== null) {
                $raw = $detection['category'];
            } elseif (isset($detection['detector']) && is_array($detection['detector'])
                      && ($detection['detector']['category'] ?? null) !== null) {
                $raw = $detection['detector']['category'];
            }
        }
        $folded = preg_replace('/[^a-z]/', '', strtolower(trim((string) $raw)));

        return self::ALIASES[$folded] ?? self::OTHER;
    }

    /** @return array<string,int> */
    public static function emptyCounts(): array
    {
        return [
            self::ANTIBOT => 0,
            self::CAPTCHA => 0,
            self::FINGERPRINT => 0,
            self::OTHER => 0,
        ];
    }
}

/** One detection, normalized without discarding what else it carried. */
final class Detection
{
    /** @param array<string,mixed> $raw */
    public function __construct(
        public readonly string $name,
        public readonly string $categoryKey,
        public readonly ?float $confidence,
        public readonly array $raw = [],
    ) {
    }

    public function get(string $field, mixed $fallback = null): mixed
    {
        return $this->raw[$field] ?? $fallback;
    }

    /** @param array<string,mixed>|null $source */
    public static function normalize(mixed $source): self
    {
        $payload = is_array($source) ? $source : [];

        $name = $payload['name'] ?? null;
        if ($name === null || $name === '') {
            $nested = $payload['detector'] ?? null;
            $name = is_array($nested) ? ($nested['name'] ?? null) : (is_string($nested) ? $nested : null);
        }
        if ($name === null || $name === '') {
            $name = 'Unknown';
        }

        // A non-numeric confidence becomes null, never a bogus number.
        $confidence = $payload['confidence'] ?? null;
        $confidence = is_int($confidence) || is_float($confidence) ? (float) $confidence : null;

        return new self((string) $name, Categories::keyOf($payload), $confidence, $payload);
    }
}

/** A result you can always read, present or not. */
final class Result
{
    /**
     * @param array<string,int> $categories
     * @param list<Detection>   $detections
     */
    public function __construct(
        public readonly bool $available,
        public readonly ?string $reason,
        public readonly ?string $url,
        public readonly ?string $timestamp,
        public readonly bool $fromCache,
        public readonly int $total,
        public readonly int $reportedTotal,
        public readonly array $categories,
        public readonly array $detections,
    ) {
    }

    public function hasCategory(string $key): bool
    {
        return $this->available && ($this->categories[strtolower(trim($key))] ?? 0) > 0;
    }

    public function isAntibot(): bool { return $this->hasCategory(Categories::ANTIBOT); }
    public function isCaptcha(): bool { return $this->hasCategory(Categories::CAPTCHA); }
    public function isFingerprinted(): bool { return $this->hasCategory(Categories::FINGERPRINT); }

    /** True when anything at all was detected, in any category. */
    public function isProtected(): bool { return $this->available && $this->total > 0; }

    /** @return list<Detection> */
    public function ofCategory(string $key): array
    {
        $wanted = strtolower(trim($key));

        return array_values(array_filter(
            $this->detections,
            static fn (Detection $d): bool => $d->categoryKey === $wanted
        ));
    }

    /** @param array<string,mixed>|null $detail */
    public static function build(bool $available, ?array $detail, ?string $reason = null): self
    {
        $payload = $detail ?? [];
        $raw = $payload['detections'] ?? null;
        $detections = [];
        $categories = Categories::emptyCounts();

        if (is_array($raw)) {
            foreach ($raw as $entry) {
                $detection = Detection::normalize($entry);
                $detections[] = $detection;
                $categories[$detection->categoryKey]++;
            }
        }

        // detectionCount is the extension's claim; count() is what arrived.
        $claimed = $payload['detectionCount'] ?? null;
        $reported = is_int($claimed) || is_float($claimed) ? (int) $claimed : count($detections);

        return new self(
            $available,
            $reason,
            isset($payload['url']) ? (string) $payload['url'] : null,
            isset($payload['timestamp']) ? (string) $payload['timestamp'] : null,
            ($payload['fromCache'] ?? false) === true,
            count($detections),
            $reported,
            $categories,
            $detections,
        );
    }

    public static function unavailable(string $reason = 'unavailable'): self
    {
        return self::build(false, null, $reason);
    }
}
