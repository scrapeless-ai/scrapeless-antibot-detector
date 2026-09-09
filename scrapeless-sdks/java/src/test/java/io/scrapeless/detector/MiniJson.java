package io.scrapeless.detector;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A minimal JSON reader, for tests only.
 *
 * <p>The SDK itself parses nothing — Playwright hands back already-decoded
 * values. This exists solely so the conformance vectors can be read without
 * adding Jackson or Gson as a dependency to a zero-dependency SDK.
 */
final class MiniJson {
    private final String text;
    private int cursor;

    private MiniJson(String text) {
        this.text = text;
    }

    static Object parse(String text) {
        MiniJson reader = new MiniJson(text);
        reader.skipBlank();
        Object value = reader.readValue();
        reader.skipBlank();
        if (reader.cursor != text.length()) {
            throw new IllegalArgumentException("trailing input at " + reader.cursor);
        }
        return value;
    }

    private void skipBlank() {
        while (cursor < text.length() && Character.isWhitespace(text.charAt(cursor))) {
            cursor++;
        }
    }

    private Object readValue() {
        char symbol = text.charAt(cursor);
        return switch (symbol) {
            case '{' -> readObject();
            case '[' -> readArray();
            case '"' -> readString();
            case 't' -> readLiteral("true", Boolean.TRUE);
            case 'f' -> readLiteral("false", Boolean.FALSE);
            case 'n' -> readLiteral("null", null);
            default -> readNumber();
        };
    }

    private Object readLiteral(String word, Object value) {
        if (!text.startsWith(word, cursor)) {
            throw new IllegalArgumentException("bad literal at " + cursor);
        }
        cursor += word.length();
        return value;
    }

    private Map<String, Object> readObject() {
        Map<String, Object> found = new LinkedHashMap<>();
        cursor++; // {
        skipBlank();
        if (text.charAt(cursor) == '}') {
            cursor++;
            return found;
        }
        while (true) {
            skipBlank();
            String key = readString();
            skipBlank();
            cursor++; // :
            skipBlank();
            found.put(key, readValue());
            skipBlank();
            char next = text.charAt(cursor++);
            if (next == '}') {
                return found;
            }
            if (next != ',') {
                throw new IllegalArgumentException("expected , or } at " + cursor);
            }
        }
    }

    private List<Object> readArray() {
        List<Object> found = new ArrayList<>();
        cursor++; // [
        skipBlank();
        if (text.charAt(cursor) == ']') {
            cursor++;
            return found;
        }
        while (true) {
            skipBlank();
            found.add(readValue());
            skipBlank();
            char next = text.charAt(cursor++);
            if (next == ']') {
                return found;
            }
            if (next != ',') {
                throw new IllegalArgumentException("expected , or ] at " + cursor);
            }
        }
    }

    private String readString() {
        StringBuilder built = new StringBuilder();
        cursor++; // opening quote
        while (true) {
            char symbol = text.charAt(cursor++);
            if (symbol == '"') {
                return built.toString();
            }
            if (symbol != '\\') {
                built.append(symbol);
                continue;
            }
            char escaped = text.charAt(cursor++);
            switch (escaped) {
                case 'n' -> built.append('\n');
                case 't' -> built.append('\t');
                case 'r' -> built.append('\r');
                case 'b' -> built.append('\b');
                case 'f' -> built.append('\f');
                case 'u' -> {
                    built.append((char) Integer.parseInt(text.substring(cursor, cursor + 4), 16));
                    cursor += 4;
                }
                default -> built.append(escaped);
            }
        }
    }

    private Object readNumber() {
        int start = cursor;
        while (cursor < text.length() && "+-.eE0123456789".indexOf(text.charAt(cursor)) >= 0) {
            cursor++;
        }
        String slice = text.substring(start, cursor);
        if (slice.contains(".") || slice.contains("e") || slice.contains("E")) {
            return Double.parseDouble(slice);
        }
        return Long.parseLong(slice);
    }
}
