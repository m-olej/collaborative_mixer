# Cloud Daw 🎛️
> Projekt zaliczeniowy z przedmiotu *Technologie internetowe w Przetwarzaniu Rozproszonym*.

**Cloud DAW** to nowoczesna, oparta na przeglądarce cyfrowa stacja robocza do obróbki dźwięku (Digital Audio Workstation). Celem projektu jest stworzenie wydajnej platformy pozwalającej wielu użytkownikom na jednoczesne, asynchroniczne miksowanie ścieżek audio w czasie rzeczywistym.

Architektura systemu łączy dwa paradygmaty komunikacji: technologię WebSocket do błyskawicznej synchronizacji stanu i strumieniowania dźwięku, oraz architekturę REST API do trwałego zarządzania zasobami (projektami, plikami i procesami renderowania). Dzięki zastosowaniu maszyny wirtualnej Erlanga (BEAM) do zarządzania potężną współbieżnością oraz języka Rust do wykonywania ciężkich obliczeń sygnałowych (DSP), aplikacja zapewnia najwyższą wydajność, brak zauważalnych opóźnień i stabilność pracy.

## 🎯 Mapowanie na Wymagania Zaliczeniowe

Projekt został zaprojektowany tak, aby zrealizować wszystkie punkty wymagane przez prowadzącego:

### Moduł WebSocket (projekt 1)

1. **Asynchroniczna kooperacja:** 

   Zmiany suwaków głośności czy EQ wykonane przez jednego użytkownika są natychmiast rozgłaszane do pozostałych w sesji.

2. **Skalowalność:** 

   Serwer potrafi obsługiwać wiele niezależnych sesji (pokojów) jednocześnie.

3. **Architektura Server-Authoritative:** 

   Serwer posiada jedno, ostateczne "źródło prawdy" o stanie miksera.

4. **Binarna komunikacja:** 

   Strumieniowanie nieskompresowanego dźwięku (PCM) oraz tablic częstotliwości (FFT) bezpośrednio do przeglądarek za pomocą binarnych ramek WebSocket.

5. **Brak ukrytych opóźnień:** 

   Eliminacja zjawiska *polling* i *busy waiting* poprzez wykorzystanie modelu aktorowego i Web Audio API.

### Moduł REST API (projekt 2)

1. **Proste zasoby oferujące pełen zakres CRUD**

   Zasób **/projects** oraz **/projects/{pid}** pozwala na tworzenie, odczytywanie, aktualizację i usuwanie podstawowych informacji o sesji DAW.

2. **Zasoby-kolekcje ze stronicowaniem**

   Zasób **/samples** obsługuje zapytania GET z parametrami do stronicowania kolekcji , na przykład: GET **/samples?genre=drums&start=0&count=50**.

3. **Zasoby z aktualizacją warunkową (Lost Update Problem)**

   Współdzielony DAW jest narażony na problem nadpisywania zmian (Lost update problem). Jeśli dwóch użytkowników offline zmieni BPM projektu i spróbuje go zapisać, serwer musi zablokować drugi request. Do aktualizacji **/projects/{pid}** za pomocą metody PUT wymagane jest przesłanie nagłówka warunkowego If-Match: "hash_wersji_z_ETag". W przypadku niezgodności serwer zwróci błąd 412 Precondition Failed lub 428 Precondition Required  (gdy nagłówka brakuje).

4. **Zasoby "POST once exactly" (Idempotentność)**

   Zlecenie wyrenderowania całego utworu do pliku WAV to bardzo kosztowna operacja dla serwera (Rusta). Zgodnie z wytycznymi z wykładu, aby uniknąć wielokrotnego przetwarzania tego samego zlecenia przy ponowieniu żądania przez klienta (np. po zerwaniu połączenia), wykorzystujemy tokeny. Zapytanie przyjmuje formę POST **/projects/{pid}/exports?token=UNIKALNY_ID**. Serwer zapamiętuje token i przy ponownej próbie wysłania tego samego żądania zwraca kod 202 Accepted lub 303 See Other  wskazujący na istniejący proces.

5. **Zasoby-kontrolery (Atomowe modyfikacje)**

   Zasób **/projects/{pid}/actions/merge-tracks** jest klasycznym zasobem-kontrolerem. Wywołanie na nim metody POST inicjuje operację, która modyfikuje wiele innych zasobów naraz: usuwa dwie istniejące ścieżki, sumuje ich pliki audio i tworzy zupełnie nową ścieżkę w bazie danych. Dzięki zamknięciu tego w dedykowanym zasobie, operacja wykonuje się na serwerze jako pojedyncza, atomowa transakcja bazodanowa.

## 🏗️ Architektura Hybrydowa 

### Podział Odpowiedzialności

Aby system działał wydajnie i spójnie, wprowadzamy ścisłą granicę między obydwoma protokołami:

1. Warstwa WebSocket (Projekt 1): 
   1. Odpowiada wyłącznie za stan ulotny i strumieniowanie. 
   2. Obsługuje przesyłanie w czasie rzeczywistym.
      1. nieskompresowanego PCM, 
      2. danych FFT do wizualizacji na Canvasie, 
      3. pozycji suwaków i głowicy odtwarzania 

2. Warstwa REST API (Projekt 2): 
   1. Odpowiada za stan trwały (zapisywany w bazie danych). 
   2. Zarządza
      1. plikami, 
      2. biblioteką dźwięków, 
      3. ustawieniami projektów,
      4. ciężkimi operacjami asynchronicznymi (np. renderingiem finalnego pliku WAV).

### Przepływ Danych

Przetwarzanie audio dzieli się na warstwę zarządzania (Elixir), obliczeń DSP (Rust) oraz prezentacji (JavaScript).

1. **Akcja użytkownika:** Użytkownik przesuwa suwak EQ na stronie. JS wysyła po WebSocket mały komunikat kontrolny do serwera Elixir.
2. **Aktualizacja Stanu:** Elixir (aktor `GenServer`) aktualizuje stan sesji i informuje o tym Rusta, jednocześnie rozsyłając nowy stan suwaków do innych klientów.
3. **Przetwarzanie (DSP):** Rust w locie aplikuje filtry na załadowanych ścieżkach audio, miksuje je do jednej ścieżki Master, wylicza transformatę Fouriera (FFT) i generuje binarną paczkę.
4. **Strumieniowanie:** Rust zwraca ramkę do Elixira, który rozsyła ją binarnie (`Float32` + `Uint8`) po WebSocket do wszystkich klientów.
5. **Odtwarzanie:** Przeglądarka odbiera dane: 
   - `Uint8Array` trafia do API `<canvas>`, który rysuje na żywo widmo dźwięku.
   - `Float32Array` z nieskompresowanym PCM trafia do bufora kołowego (Ring Buffer) w `AudioWorklet`, skąd jest przesyłany na głośniki.

## 🛠️ Technologie i Narzędzia
### Frontend: Interfejs i Wydajność (React & Web Audio API)

W warstwie prezentacji kluczowe jest rozdzielenie logiki biznesowej od renderowania danych o wysokiej częstotliwości zmian.

#### React (UI & State Management): 
Wykorzystywany do budowy struktury aplikacji i zarządzania "wolnym" stanem (np. metadane projektu, lista ścieżek, ustawienia użytkownika). Dzięki komponentowości React idealnie nadaje się do budowy modułowego miksera.

* Optymalizacja useRef (Direct DOM Manipulation): 
  * Aby uniknąć wąskiego gardła, jakim jest proces uzgadniania (reconciliation) Wirtualnego DOM-u, parametry czasu rzeczywistego (pozycje suwaków głośności, wskaźniki wysterowania poziomu sygnału, Playhead) są aktualizowane bezpośrednio.
  * Wartości przychodzące z WebSocket trafiają do referencji useRef.
  * Zmiany wizualne są aplikowane bezpośrednio do właściwości CSS lub atrybutów Canvas z pominięciem cyklu renderowania Reacta. Zapobiega to gubieniu klatek (frame drops) przy 60 FPS.

#### Web Audio API (AudioWorklet): 
Przeniesienie przetwarzania audio do dedykowanego wątku audio. Dzięki temu odtwarzanie dźwięku jest całkowicie odseparowane od głównego wątku JavaScript (Main Thread), co eliminuje ryzyko trzasków i przerw w dźwięku nawet przy dużym obciążeniu interfejsu graficznego.

#### Canvas API: 

Wykorzystywane do renderowania oscylogramów i wizualizacji FFT (spektrum) w czasie rzeczywistym, zapewniając płynność grafiki bez obciążania procesora zbędnymi operacjami na DOM.

## Backend: Zarządzanie Sesją i Komunikacja (Elixir & Erlang VM)

Wykorzystanie maszyny wirtualnej BEAM pozwala na obsługę tysięcy równoległych sesji miksowania przy minimalnym narzucie.

#### Elixir & Phoenix Channels: 

Warstwa transportowa dla WebSocket. Zapewnia stabilne połączenie i abstrakcję "kanałów", co pozwala na łatwą implementację wieloosobowych pokojów (rooms).

* GenServer (Stateful Sessions): 
  * Każda aktywna sesja projektu jest reprezentowana przez dedykowany proces GenServer.
  * Pełni on rolę "źródła prawdy" (Source of Truth) dla danego pokoju.
  * Przechowuje aktualny stan miksu (pozycje suwaków, parametry filtrów).
  * Obsługuje komunikację z modułem DSP w Ruście oraz koordynuje rozsyłanie (broadcast) aktualizacji do wszystkich połączonych klientów.

#### Rustler (NIF Bridge): 

Bezpieczny most łączący Elixira z Rustem. Pozwala na wywoływanie natywnego kodu DSP z zachowaniem izolacji procesów Erlanga – błąd w module audio nie powoduje restartu całego serwera sieciowego.

## Backend: Cyfrowe Przetwarzanie Sygnału (Rust DSP)

Rust dostarcza deterministyczną wydajność niezbędną do operacji na strumieniach audio.

#### Rust: Język systemowy odpowiedzialny za niskopoziomowe manipulacje na buforach danych f32. Dzięki brakowi Garbage Collectora, operacje miksowania i filtrowania odbywają się z przewidywalnym, minimalnym opóźnieniem.

* Biblioteki DSP:
  * symphonia: Wydajne dekodowanie plików źródłowych bezpośrednio do pamięci RAM.
  * biquad: Zestaw filtrów do implementacji korektora barwy (EQ).
  * rustfft: Generowanie precyzyjnych danych spektralnych przesyłanych do frontendu.
  * hound: eksport finalnego produktu do uspójnionego formatu audio WAV
  * rubato: resampling próbek audio, uspójnianie parametrów różnych ścieżek do jednego standardu
  * tempfile: zapisywanie niekompletnych plików do chwilowych lokalizacji przed zakończeniem długo działających operacji. 

## Infrastruktura i Dane (REST & Persystencja)

### PostgreSQL & Ecto: 
Przechowywanie trwałych danych, takich jak konta użytkowników, struktury projektów (układ ścieżek) oraz biblioteka sampli.

### REST API (Phoenix Controllers): 
Obsługa operacji CRUD oraz ciężkich procesów, takich jak eksport gotowego utworu do formatu WAV.

## 🗂️ Projekt API REST: Tabela Operacji
Poniższa tabela przedstawia hierarchię zasobów oraz obsługiwane przez nie metody HTTP. Znak "X" oznacza operację niedozwoloną (zwracającą kod 405 Method Not Allowed).

|URI Zasobu|GET|POST|PUT|DELETE|
|---|---|---|---|---|
|/projects|Lista projektów|Tworzenie projektu|X|X|
|/projects/{pid}|Info o projekcie|X|Aktualizacja metadanych|Usunięcie projektu|
|/samples|Lista sampli w chmurze|Wgranie (Upload) sampla|X|X|
|/samples/{sid}|Pobranie/Info o samplu|X|X|Usunięcie sampla|
|/projects/{pid}/exports|Lista historii renderów|Zlecenie renderu (miksowania)|X|X|
|/projects/{pid}/exports/{eid}|Pobranie gotowego pliku|X|X|Usunięcie pliku renderu|
|/projects/{pid}/actions/merge-tracks|Historia operacji łączenia|Wykonanie atomowego złączenia|X|X|

## 💾 Reprezentacja Danych (Wejście / Wyjście)

Standardowym formatem wymiany danych tekstowych w całym API jest **application/json**. 
Poniżej szczegółowy podział dla poszczególnych zasobów:

### /projects oraz /projects/{pid}

   **Wejście** (POST/PUT): JSON z ustawieniami, np. {"name": "My Song", "bpm": 120, "time_signature": "4/4"}.

   **Wyjście** (GET): JSON z reprezentacją zasobu.

### /samples

   **Wejście** (POST): **multipart/form-data** do przesyłania plików audio (WAV, MP3) wraz z metadanymi (nazwa, kategoria).

   **Wyjście** (GET): JSON zawierający tablicę obiektów.

### /samples/{sid} oraz /projects/{pid}/exports/{eid}

   **Wyjście** (GET): Strumień binarny audio/wav (pobieranie pliku) lub JSON z metadanymi (w zależności od nagłówka Accept – tzw. Content Negotiation ).

### /projects/{pid}/actions/merge-tracks

   **Wejście** (POST): JSON zawierający tablicę ID ścieżek do złączenia: {"track_ids": ["t1", "t2"], "new_name": "Merged Vocals"}.

   **Wyjście** (POST): JSON z ID nowo utworzonej ścieżki (kod 201 Created ).