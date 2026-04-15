# Collaborative Audio Mixer 🎛️
> Projekt zaliczeniowy z przedmiotu *Technologie internetowe w Przetwarzaniu Rozproszonym*.

Aplikacja webowa pozwalająca wielu użytkownikom na jednoczesne, asynchroniczne miksowanie ścieżek audio w czasie rzeczywistym. 

## 🎯 Założenia Projektu

Celem projektu jest stworzenie platformy, w której wielu użytkowników łączy się w tzw. "pokojach" i wspólnie modyfikuje brzmienie odtwarzanego strumienia audio. Główne założenia to:
* **Asynchroniczna kooperacja:** Zmiany suwaków głośności czy EQ wykonane przez jednego użytkownika są natychmiast rozgłaszane do pozostałych w sesji.
* **Skalowalność:** Serwer potrafi obsługiwać wiele niezależnych sesji (pokojów) jednocześnie.
* **Architektura Server-Authoritative:** Serwer posiada jedno, ostateczne "źródło prawdy" o stanie miksera.
* **Binarna komunikacja:** Strumieniowanie nieskompresowanego dźwięku (PCM) oraz tablic częstotliwości (FFT) bezpośrednio do przeglądarek za pomocą binarnych ramek WebSocket.
* **Brak ukrytych opóźnień:** Eliminacja zjawiska *polling* i *busy waiting* poprzez wykorzystanie modelu aktorowego i Web Audio API.

## 🏗️ Architektura i Przepływ Danych

Aplikacja opiera się na rozdzieleniu odpowiedzialności między trzy kluczowe warstwy: zarządzania (Elixir), obliczeń DSP (Rust) oraz prezentacji (JavaScript).

1. **Akcja użytkownika:** Użytkownik przesuwa suwak EQ na stronie. JS wysyła po WebSocket mały komunikat kontrolny do serwera Elixir.
2. **Aktualizacja Stanu:** Elixir (aktor `GenServer`) aktualizuje stan sesji i informuje o tym Rusta, jednocześnie rozsyłając nowy stan suwaków do innych klientów.
3. **Przetwarzanie (DSP):** Rust w locie aplikuje filtry na załadowanych ścieżkach audio, miksuje je do jednej ścieżki Master, wylicza transformatę Fouriera (FFT) i generuje binarną paczkę.
4. **Strumieniowanie:** Rust zwraca ramkę do Elixira, który rozsyła ją binarnie (`Float32` + `Uint8`) po WebSocket do wszystkich klientów.
5. **Odtwarzanie:** Przeglądarka odbiera dane: 
   - `Uint8Array` trafia do API `<canvas>`, który rysuje na żywo widmo dźwięku.
   - `Float32Array` z nieskompresowanym PCM trafia do bufora kołowego (Ring Buffer) w `AudioWorklet`, skąd jest przesyłany na głośniki.

## 🛠️ Technologie i Narzędzia

### Backend: Zarządzanie i Sieć (Erlang VM)
* **Elixir & Phoenix (Channels):** Wybrane ze względu na model współbieżności oparty na aktorach. Maszyna wirtualna BEAM (Erlang) utrzymuje połączenia WebSocket, nie blokując się nawzajem. Każdy pokój miksera to lekki proces (GenServer), który przechowuje stan – co rozwiązuje problem utraty danych przy odświeżeniu strony.
* **Rustler:** Biblioteka tworząca bezpieczny most (NIF - Native Implemented Functions) pomiędzy maszyną Erlanga a kodem w Ruście. Zapobiega crashowaniu się serwera w przypadku błędu w niższym poziomie.

### Backend: Cyfrowe Przetwarzanie Sygnału (DSP)
* **Rust:** Użyty tam, gdzie BEAM jest słaby – w zakresie intensywnych obliczeń. Przetwarzanie audio wymaga wysokiej wydajności procesora i przewidywalnego zarządzania pamięcią.
* **symphonia:** Czysty, wydajny dekoder formatów audio.
* **biquad:** Implementacja cyfrowych filtrów EQ (High, Mid, Low) w czasie rzeczywistym.
* **rustfft:** Zoptymalizowana biblioteka do wyliczania dyskretnej transformaty Fouriera, niezbędna do zasilenia wizualizera Canvas na frontendzie.

### Frontend: Klient (Vanilla JS)
* **Web Audio API (`AudioWorklet`):** Domyślne API `AudioContext` działa na głównym wątku przeglądarki, co przy asynchronicznym streamowaniu audio mogłoby powodować zacinanie się dźwięku (buffer underruns) podczas np. przerysowywania DOM. `AudioWorklet` rozwiązuje ten problem, odtwarzając próbki PCM w całkowicie izolowanym, niskopoziomowym wątku.
* **Canvas API:** Renderowanie w 60 klatkach na sekundę (`requestAnimationFrame`) paska częstotliwości (FFT) na podstawie danych odbieranych ze strumienia serwera.
* **live-server:** Lekki serwer deweloperski niezbędny, by restrykcje bezpieczeństwa przeglądarek pozwoliły na uruchomienie modułów Worklet oraz API sieciowych (często blokowane z poziomu `file://`).