def main():
    try:
        # Chiedi in input i due numeri
        num1 = float(input("Inserisci il primo numero: "))
        num2 = float(input("Inserisci il secondo numero: "))
        
        # Mostra le operazioni disponibili
        print("\nScegli l'operazione da eseguire:")
        print("1. Addizione (+)")
        print("2. Sottrazione (-)")
        print("3. Moltiplicazione (*)")
        print("4. Divisione (/)")
        
        # Chiedi in input l'operazione
        scelta = input("\nInserisci il numero o il simbolo dell'operazione: ")
        
        # Esegui l'operazione e stampa il risultato
        if scelta in ('1', '+'):
            risultato = num1 + num2
            operazione = '+'
        elif scelta in ('2', '-'):
            risultato = num1 - num2
            operazione = '-'
        elif scelta in ('3', '*'):
            risultato = num1 * num2
            operazione = '*'
        elif scelta in ('4', '/'):
            if num2 == 0:
                print("\nErrore: Impossibile dividere per zero.")
                return
            risultato = num1 / num2
            operazione = '/'
        else:
            print("\nErrore: Scelta non valida.")
            return
            
        print(f"\nRisultato: {num1} {operazione} {num2} = {risultato}")
        
    except ValueError:
        print("\nErrore: Assicurati di inserire dei numeri validi.")

if __name__ == "__main__":
    main()
